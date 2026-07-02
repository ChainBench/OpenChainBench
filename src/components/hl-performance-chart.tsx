"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Per-builder Performance chart: daily revenue bars + a unique-users
 * line overlay, with a 30d / 90d / 1y range picker.
 *
 * Data-source routing:
 *   - 30d: live on-node harness `/daily-series` (in-memory 30-day ring,
 *     includes real per-day unique-users counts).
 *   - 90d / 1y: hl-archive DuckDB via `/daily-history?days=N` (≈11
 *     months backfilled at the time of writing). The archive doesn't
 *     store per-day users so `users` comes back as 0 for those ranges;
 *     the line-overlay flavour falls back to a revenue-line-only render.
 *
 * Visual choices:
 *   - 30d keeps the original bar chart with the users overlay.
 *   - 90d densifies bars (no gap) so 90 bars still read as a histogram.
 *   - 1y switches to a smooth revenue area/line so ~365 daily samples
 *     don't turn into a wall of 1-px bars.
 *   - Biggest-day marker is always recomputed on the active series.
 *
 * Client component because the data fetch hits the API after hydration
 * (and switches upstream when the user flips the range). Hides silently
 * if every upstream is unreachable (graceful degradation).
 */

type Point = {
  date: string;
  day_unix: number;
  fees_usd: number;
  volume_usd: number;
  users: number;
};

type Payload = {
  builder: string;
  as_of: number;
  days: number;
  points: Point[];
};

const REVENUE_COLOR = "#9d65ff";
const REVENUE_COLOR_TOP = "#bca0ff";
const USERS_COLOR = "#ff8a3d";

type Range = "30d" | "90d" | "1y";

const RANGE_OPTIONS: { key: Range; label: string; days: number }[] = [
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
  { key: "1y", label: "1y", days: 365 },
];

function urlForRange(slug: string, range: Range): string {
  if (range === "30d") {
    return `/api/builder/${encodeURIComponent(slug)}/daily-series`;
  }
  const days = range === "90d" ? 90 : 365;
  return `/api/builder/${encodeURIComponent(slug)}/daily-history?days=${days}`;
}

export function HlPerformanceChart({
  slug,
  biggestDayUnix,
}: {
  slug: string;
  biggestDayUnix?: number;
}) {
  const [range, setRange] = useState<Range>("30d");
  // Track load state per (slug, range) fetch key. We only surface the
  // stored result when its key matches the current one, so switching
  // range instantly shows a spinner without a synchronous setState at
  // the top of the effect (which trips react-hooks/set-state-in-effect).
  type Load =
    | { key: string; state: "done"; data: Payload }
    | { key: string; state: "error"; error: string };
  const [load, setLoad] = useState<Load | null>(null);
  const fetchKey = `${slug}|${range}`;
  const active = load && load.key === fetchKey ? load : null;

  useEffect(() => {
    let cancelled = false;
    fetch(urlForRange(slug, range), { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`)),
      )
      .then((p: Payload) => {
        if (!cancelled) setLoad({ key: fetchKey, state: "done", data: p });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoad({
            key: fetchKey,
            state: "error",
            error: e instanceof Error ? e.message : String(e),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, range, fetchKey]);

  const data = active?.state === "done" ? active.data : null;
  const loading = active === null;
  const error = active?.state === "error" ? active.error : null;

  // Keep the 30d canvas visible if the long-window fetch fails: the
  // chart still has value at the default range and the picker can
  // recover from a transient archive brownout.
  if (error && !data) {
    if (typeof console !== "undefined")
      console.warn(`HlPerformanceChart fetch failed for ${slug}:`, error);
    return null;
  }
  if (loading && !data) {
    return (
      <div className="mt-6 card-soft rounded-xl p-4 border border-ink/10 h-[340px] animate-pulse" />
    );
  }
  if (!data || data.points.length === 0) return null;

  return (
    <ChartCanvas
      data={data}
      biggestDayUnix={biggestDayUnix}
      range={range}
      onRangeChange={setRange}
      loading={loading}
      hasError={error !== null}
    />
  );
}

function ChartCanvas({
  data,
  biggestDayUnix,
  range,
  onRangeChange,
  loading,
  hasError,
}: {
  data: Payload;
  biggestDayUnix?: number;
  range: Range;
  onRangeChange: (r: Range) => void;
  loading: boolean;
  hasError: boolean;
}) {
  const W = 1100;
  const H = 340;
  const PAD_L = 60;
  const PAD_R = 60;
  const PAD_T = 28;
  const PAD_B = 56;

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = data.points.length;

  const maxFees = useMemo(
    () => Math.max(...data.points.map((p) => p.fees_usd), 0),
    [data.points],
  );
  const maxUsers = useMemo(
    () => Math.max(...data.points.map((p) => p.users), 0),
    [data.points],
  );

  const totalFees30d = useMemo(
    () => data.points.reduce((a, p) => a + p.fees_usd, 0),
    [data.points],
  );
  const totalVol30d = useMemo(
    () => data.points.reduce((a, p) => a + p.volume_usd, 0),
    [data.points],
  );
  const peakUsers = useMemo(
    () => Math.max(...data.points.map((p) => p.users)),
    [data.points],
  );

  const niceMaxFees = niceMax(maxFees);
  const niceMaxUsers = niceMax(maxUsers);

  // Render mode: bars for the two shorter ranges (readable at
  // <=90 samples); line-area for 1y so ~365 daily samples don't collapse
  // into a wall of 1-px bars. The 30d range is the only one that carries
  // real per-day users data (hl-archive doesn't persist daily uniques),
  // so the users overlay only lights up on 30d.
  const isLine = range === "1y";
  const showUsersOverlay = range === "30d" && maxUsers > 0;

  // Squeeze the inter-bar gap for the mid range so 90 bars still read
  // as a histogram; 30d keeps the original breathing room.
  const barGap = range === "30d" ? 6 : range === "90d" ? 2 : 1;
  const barW = Math.max(1, plotW / n - barGap);
  const xFor = (i: number) => PAD_L + (plotW * (i + 0.5)) / n;
  const yBar = (v: number) =>
    PAD_T + plotH - (niceMaxFees > 0 ? (v / niceMaxFees) * plotH : 0);
  const yLine = (v: number) =>
    PAD_T + plotH - (niceMaxUsers > 0 ? (v / niceMaxUsers) * plotH : 0);
  const yRev = (v: number) =>
    PAD_T + plotH - (niceMaxFees > 0 ? (v / niceMaxFees) * plotH : 0);

  const ticks = [0, 0.25, 0.5, 0.75, 1.0];
  const xLabelEvery = Math.max(1, Math.ceil(n / 7));

  // Users overlay poly-line — only used for 30d.
  const usersLinePath = data.points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yLine(p.users).toFixed(1)}`,
    )
    .join(" ");
  const usersAreaPath = `${usersLinePath} L ${xFor(n - 1).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`;

  // Revenue line + area — used for the 1y range where individual bars
  // would be unreadable.
  const revLinePath = data.points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yRev(p.fees_usd).toFixed(1)}`,
    )
    .join(" ");
  const revAreaPath = `${revLinePath} L ${xFor(n - 1).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(PAD_T + plotH).toFixed(1)} Z`;

  // Biggest day annotation. ALWAYS computed from the displayed series,
  // never from the server-rendered `biggestDayUnix` prop alone. The two
  // sources race: the page server-renders biggestDayUnix from a Prom
  // scalar cached for the ISR window (60-300 s) while the chart fetches
  // /api/builder/<slug>/daily-series at hydration time and gets the
  // fresh JSON straight from the harness. When a new biggest day rolls
  // in between those two reads, the marker stops landing on the tallest
  // bar (it points to the previous biggest, which is still in the
  // series but no longer the max).
  //
  // The server prop is kept as a tiebreaker: if it falls inside the
  // displayed series and the series is uniformly zero (cold start,
  // never observed a fill), surface its UTC day so the marker still
  // shows up. In every other case the series tells us which bar is the
  // tallest, which is exactly what the marker is supposed to point at.
  const biggestIdx = useMemo(() => {
    let bestI = -1;
    let bestV = 0;
    for (let i = 0; i < data.points.length; i++) {
      if (data.points[i].fees_usd > bestV) {
        bestV = data.points[i].fees_usd;
        bestI = i;
      }
    }
    if (bestI >= 0) return bestI;
    if (biggestDayUnix && biggestDayUnix > 0) {
      const found = data.points.findIndex(
        (p) => Math.abs(p.day_unix - biggestDayUnix) < 86400,
      );
      if (found >= 0) return found;
    }
    return -1;
  }, [data.points, biggestDayUnix]);

  // Hover state. We track the index of the hovered bar (the bar a
  // pointer x-coord falls into) and the bounding rect to position the
  // floating tooltip. SVG -> screen coords is done with getBoundingClientRect.
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const onMove: React.PointerEventHandler<SVGSVGElement> = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const px = xRatio * W;
    if (px < PAD_L || px > W - PAD_R) {
      setHover(null);
      return;
    }
    const i = Math.min(n - 1, Math.max(0, Math.floor(((px - PAD_L) / plotW) * n)));
    setHover(i);
  };

  return (
    <div
      className="mt-6 rounded-xl p-4 sm:p-6 border border-ink/10"
      style={{
        background:
          "linear-gradient(180deg, rgba(157,101,255,0.05), rgba(157,101,255,0.01) 60%, transparent)",
        boxShadow:
          "0 1px 0 rgba(0,0,0,0.02), 0 8px 24px -16px rgba(60,40,110,0.18)",
      }}
    >
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <p className="label-mono text-[10px] text-ink-faint">
            Performance · last {range}
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            {showUsersOverlay
              ? "Daily builder revenue and unique active users"
              : "Daily builder revenue and volume"}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <RangePicker
            value={range}
            onChange={onRangeChange}
            loading={loading}
          />
          <div className="flex items-center gap-4 text-[11px]">
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-[3px]"
                style={{
                  background: `linear-gradient(180deg, ${REVENUE_COLOR_TOP}, ${REVENUE_COLOR})`,
                }}
              />
              <span className="font-medium text-ink">Revenue</span>
            </span>
            {showUsersOverlay && (
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block w-3 h-3 rounded-full border border-paper"
                  style={{
                    background: USERS_COLOR,
                    boxShadow: `0 0 0 1.5px ${USERS_COLOR}33`,
                  }}
                />
                <span className="font-medium text-ink">Users</span>
              </span>
            )}
          </div>
        </div>
      </div>
      {hasError && (
        <p className="mb-2 text-[11px] text-ink-faint">
          Long-window archive unreachable; showing the last successful load.
        </p>
      )}

      <div className="relative w-full overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-[300px] sm:h-[340px] block"
          preserveAspectRatio="none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="hl-rev-grad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={REVENUE_COLOR_TOP} stopOpacity={0.95} />
              <stop offset="100%" stopColor={REVENUE_COLOR} stopOpacity={0.85} />
            </linearGradient>
            <linearGradient id="hl-rev-grad-hover" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#d6c2ff" stopOpacity={1} />
              <stop offset="100%" stopColor={REVENUE_COLOR} stopOpacity={1} />
            </linearGradient>
            <linearGradient id="hl-users-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={USERS_COLOR} stopOpacity={0.28} />
              <stop offset="100%" stopColor={USERS_COLOR} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="hl-rev-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={REVENUE_COLOR} stopOpacity={0.32} />
              <stop offset="100%" stopColor={REVENUE_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>

          {ticks.map((t) => {
            const y = PAD_T + plotH * (1 - t);
            const valFees = niceMaxFees * t;
            const valUsers = niceMaxUsers * t;
            return (
              <g key={t}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-ink/8"
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? "0" : "2 4"}
                />
                <text
                  x={PAD_L - 8}
                  y={y + 3}
                  textAnchor="end"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                  className="fill-ink-faint text-[10px] tabular-nums"
                >
                  {fmtUSDShort(valFees)}
                </text>
                {showUsersOverlay && (
                  <text
                    x={W - PAD_R + 8}
                    y={y + 3}
                    textAnchor="start"
                    style={{ fontFamily: "var(--font-mono, monospace)" }}
                    className="fill-ink-faint text-[10px] tabular-nums"
                  >
                    {fmtCountShort(valUsers)}
                  </text>
                )}
              </g>
            );
          })}

          {showUsersOverlay && (
            <path d={usersAreaPath} fill="url(#hl-users-area)" />
          )}

          {biggestIdx >= 0 && (
            <g>
              <line
                x1={xFor(biggestIdx)}
                x2={xFor(biggestIdx)}
                y1={PAD_T - 4}
                y2={PAD_T + plotH}
                stroke={REVENUE_COLOR}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.55}
              />
              <text
                x={xFor(biggestIdx)}
                y={PAD_T - 8}
                textAnchor="middle"
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 9.5,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  fill: REVENUE_COLOR,
                }}
              >
                ★ biggest day
              </text>
            </g>
          )}

          {!isLine &&
            data.points.map((p, i) => {
              const x = xFor(i) - barW / 2;
              const y = yBar(p.fees_usd);
              const h = PAD_T + plotH - y;
              const isHovered = hover === i;
              return (
                <rect
                  key={p.day_unix}
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(1, h)}
                  rx={Math.min(3, barW / 2)}
                  ry={Math.min(3, barW / 2)}
                  fill={isHovered ? "url(#hl-rev-grad-hover)" : "url(#hl-rev-grad)"}
                  opacity={hover === null ? 1 : isHovered ? 1 : 0.55}
                  style={{ transition: "opacity 120ms ease-out" }}
                />
              );
            })}

          {isLine && (
            <>
              <path d={revAreaPath} fill="url(#hl-rev-area)" />
              <path
                d={revLinePath}
                fill="none"
                stroke={REVENUE_COLOR}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {hover !== null && (
                <circle
                  cx={xFor(hover)}
                  cy={yRev(data.points[hover].fees_usd)}
                  r={4}
                  fill={REVENUE_COLOR}
                  stroke="var(--color-paper, #fff)"
                  strokeWidth={2}
                />
              )}
            </>
          )}

          {showUsersOverlay && (
            <>
              <path
                d={usersLinePath}
                fill="none"
                stroke={USERS_COLOR}
                strokeWidth={2.25}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {data.points.map((p, i) => {
                const isHovered = hover === i;
                return (
                  <g key={p.day_unix}>
                    <circle
                      cx={xFor(i)}
                      cy={yLine(p.users)}
                      r={isHovered ? 5 : 3.2}
                      fill="var(--color-paper, #fff)"
                      opacity={hover === null || isHovered ? 1 : 0.7}
                    />
                    <circle
                      cx={xFor(i)}
                      cy={yLine(p.users)}
                      r={isHovered ? 3.4 : 2}
                      fill={USERS_COLOR}
                    />
                  </g>
                );
              })}
            </>
          )}

          {hover !== null && (
            <line
              x1={xFor(hover)}
              x2={xFor(hover)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="currentColor"
              className="text-ink/25"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          )}

          {data.points.map((p, i) =>
            i % xLabelEvery === 0 || i === n - 1 ? (
              <text
                key={p.day_unix}
                x={xFor(i)}
                y={H - PAD_B + 18}
                textAnchor="middle"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
                className="fill-ink-faint text-[10px] tabular-nums"
                transform={`rotate(-12 ${xFor(i)} ${H - PAD_B + 18})`}
              >
                {fmtShortDate(p.date)}
              </text>
            ) : null,
          )}
        </svg>

        {hover !== null && (
          <Tooltip
            point={data.points[hover]}
            isBiggest={hover === biggestIdx}
            showUsers={showUsersOverlay}
            xFrac={xFor(hover) / W}
            yFrac={
              (showUsersOverlay
                ? Math.min(
                    yBar(data.points[hover].fees_usd),
                    yLine(data.points[hover].users),
                  )
                : yBar(data.points[hover].fees_usd)) / H
            }
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
        <Stat
          label={`Revenue ${range}`}
          value={fmtUSD(totalFees30d)}
          accent={REVENUE_COLOR}
        />
        <Stat label={`Volume ${range}`} value={fmtUSD(totalVol30d)} />
        {showUsersOverlay ? (
          <Stat
            label="Peak users / day"
            value={fmtCountShort(peakUsers)}
            accent={USERS_COLOR}
          />
        ) : (
          <Stat
            label="Days covered"
            value={String(n)}
          />
        )}
        <Stat
          label="As of"
          value={new Date(data.as_of * 1000).toUTCString().slice(5, 25) + " UTC"}
          mono
        />
      </div>
    </div>
  );
}

function RangePicker({
  value,
  onChange,
  loading,
}: {
  value: Range;
  onChange: (r: Range) => void;
  loading: boolean;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-ink/15 bg-paper/60 p-0.5 text-[11px]"
      role="tablist"
      aria-label="Chart range"
    >
      {RANGE_OPTIONS.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={loading && !active}
            onClick={() => onChange(opt.key)}
            className={
              "px-2.5 py-1 rounded-[5px] font-medium tabular-nums transition-colors " +
              (active
                ? "bg-ink text-paper"
                : "text-ink-faint hover:text-ink")
            }
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Tooltip({
  point,
  isBiggest,
  showUsers,
  xFrac,
  yFrac,
}: {
  point: Point;
  isBiggest: boolean;
  showUsers: boolean;
  xFrac: number;
  yFrac: number;
}) {
  // Position over the canvas in % units — keeps it sticky as the svg
  // scales responsively. Clamp so the card doesn't run off either edge.
  const left = Math.max(4, Math.min(96, xFrac * 100));
  const top = Math.max(6, yFrac * 100 - 6);
  const flipX = left > 70;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg border border-ink/15 bg-paper shadow-lg px-3 py-2 text-[11.5px]"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(${flipX ? "-100%" : "0%"}, -100%) translateX(${flipX ? -8 : 8}px) translateY(-6px)`,
        minWidth: 168,
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <span
          className="label-mono text-[10px] text-ink-faint"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {point.date}
        </span>
        {isBiggest && (
          <span
            className="text-[9px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5"
            style={{ background: `${REVENUE_COLOR}22`, color: REVENUE_COLOR }}
          >
            ★ biggest
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 leading-tight">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{
              background: `linear-gradient(180deg, ${REVENUE_COLOR_TOP}, ${REVENUE_COLOR})`,
            }}
          />
          <span className="text-ink-faint">Revenue</span>
        </span>
        <span className="font-semibold tabular-nums">
          {fmtUSD(point.fees_usd)}
        </span>
      </div>
      {showUsers && (
        <div className="flex items-center justify-between gap-3 leading-tight mt-0.5">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ background: USERS_COLOR }}
            />
            <span className="text-ink-faint">Users</span>
          </span>
          <span className="font-semibold tabular-nums">
            {fmtCountShort(point.users)}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 leading-tight mt-0.5">
        <span className="text-ink-faint">Volume</span>
        <span className="font-semibold tabular-nums">
          {fmtUSD(point.volume_usd)}
        </span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  mono,
}: {
  label: string;
  value: string;
  accent?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-ink/8 bg-paper/60 px-3 py-2">
      <p
        className="label-mono text-[9.5px] text-ink-faint uppercase tracking-wide flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p
        className={`mt-0.5 text-sm font-semibold tabular-nums ${mono ? "" : ""}`}
        style={mono ? { fontFamily: "var(--font-mono, monospace)" } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  if (f <= 1) return exp;
  if (f <= 2) return 2 * exp;
  if (f <= 5) return 5 * exp;
  return 10 * exp;
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtCountShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtShortDate(d: string): string {
  const [, mm, dd] = d.split("-");
  return `${dd}/${mm}`;
}
