"use client";

import { useMemo, useRef, useState } from "react";
import type {
  HlHistoryFrontendCompact,
  HlHistorySummary,
} from "@/lib/hl-builder-stats";

/**
 * 12-month evolution chart for every active HL frontend (~98). Two
 * toggleable metrics (fees / volume, both 30d rolling). Top-N frontends
 * are drawn in the OCB palette; the remaining "long tail" renders in a
 * desaturated grey overlay so the eye still gets the shape of the
 * cohort's overall scale without the legend blowing up.
 *
 * The input blob is the compact shape written by the worker:
 *   - shared time axis `t0 + step*i`
 *   - per-frontend `firstIdx` drops leading nulls
 *   - values are pre-rounded to integer USD
 *
 * Design goals:
 *   - Stays a single SVG. No recharts / D3. 98 × 365 int points renders
 *     comfortably; grey tail lines share a single `<path>` styling.
 *   - Gaps: `v === null` points break the line rather than dropping to
 *     zero. Matches the harness' "no sample this UTC day" semantic and
 *     keeps early-history cohorts (post-launch) from starting from an
 *     artificial floor.
 *   - Colours: 10-slot OCB palette, cycled if the top set grows past
 *     10. Hovered / pinned line lifts to full opacity; the rest dim.
 *   - Crosshair tooltip lists top-N + hovered tail entry so the reader
 *     never chases a grey line without a label.
 */

const COLORS = [
  "#9d65ff", // violet
  "#ff8a3d", // orange
  "#22c55e", // emerald
  "#38bdf8", // sky
  "#f43f5e", // rose
  "#eab308", // amber
  "#14b8a6", // teal
  "#a855f7", // fuchsia
  "#f97316", // deep orange
  "#0ea5e9", // blue
  "#84cc16", // lime
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f59e0b", // dark amber
  "#10b981", // green
  "#8b5cf6", // purple
  "#ef4444", // red
  "#3b82f6", // indigo
  "#d946ef", // magenta
  "#65a30d", // olive
];

/** How many frontends get a colour + legend entry. The rest are drawn
 *  as a desaturated grey overlay so the chart shows the full cohort's
 *  scale without the legend collapsing under 98 chips. */
const TOP_COLORED = 20;

type Metric = "fees" | "volume";

export function HlHistoryChart({
  history,
  focusSlugs,
}: {
  history: HlHistorySummary;
  /** When provided, only these slugs render (all in colour, no grey
   *  long-tail overlay, no top/tail split). Powers the per-frontend
   *  detail page at `/hyperliquid/[slug]`. */
  focusSlugs?: string[];
}) {
  const [metric, setMetric] = useState<Metric>("fees");
  const [pinnedSlug, setPinnedSlug] = useState<string | null>(null);

  const focusSet = useMemo(
    () => (focusSlugs && focusSlugs.length > 0 ? new Set(focusSlugs) : null),
    [focusSlugs],
  );

  const activeFrontends = useMemo(
    () =>
      focusSet
        ? history.frontends.filter((f) => focusSet.has(f.slug))
        : history.frontends,
    [history.frontends, focusSet],
  );
  if (activeFrontends.length === 0) {
    return (
      <p className="text-sm text-ink-faint italic">
        No history samples yet — the backfill is still populating.
      </p>
    );
  }

  // Focus mode: every requested slug gets a colour; skip the grey tail.
  const topFrontends = focusSet
    ? activeFrontends
    : activeFrontends.slice(0, TOP_COLORED);
  const tailFrontends = focusSet ? [] : activeFrontends.slice(TOP_COLORED);

  return (
    <div
      className="rounded-xl border border-ink/10 p-4 sm:p-6"
      style={{
        background:
          "linear-gradient(180deg, rgba(157,101,255,0.04), rgba(157,101,255,0.01) 60%, transparent)",
        boxShadow:
          "0 1px 0 rgba(0,0,0,0.02), 0 8px 24px -16px rgba(60,40,110,0.16)",
      }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label-mono text-[10px] text-ink-faint">
            Last 12 months · rolling 30d
          </p>
          <p className="text-sm text-ink-faint mt-0.5">
            Daily-stepped snapshot of {activeFrontends.length} HL frontends
            {tailFrontends.length > 0 ? (
              <>
                {" "}
                — top {TOP_COLORED} highlighted, {tailFrontends.length} in the
                grey long tail
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="label-mono text-[10px] rounded border border-ink/15 px-1.5 py-0.5 text-ink-soft bg-paper-soft/40"
            title="Y axis uses log10 scale so long-tail frontends stay legible against $1M+ leaders."
          >
            log10 scale
          </span>
          <div className="inline-flex rounded-md border border-ink/15 text-[11px] overflow-hidden">
          <button
            type="button"
            onClick={() => setMetric("fees")}
            className={`px-3 py-1.5 font-medium ${
              metric === "fees"
                ? "bg-ink text-paper"
                : "text-ink-soft hover:bg-paper-soft/60"
            }`}
          >
            Fees 30d
          </button>
          <button
            type="button"
            onClick={() => setMetric("volume")}
            className={`px-3 py-1.5 font-medium border-l border-ink/15 ${
              metric === "volume"
                ? "bg-ink text-paper"
                : "text-ink-soft hover:bg-paper-soft/60"
            }`}
          >
            Volume 30d
          </button>
          </div>
        </div>
      </div>

      <ChartCanvas
        history={history}
        topFrontends={topFrontends}
        tailFrontends={tailFrontends}
        metric={metric}
        pinnedSlug={pinnedSlug}
      />

      <div className="mt-4 flex flex-wrap gap-2">
        {topFrontends.map((f, i) => {
          const color = COLORS[i % COLORS.length];
          const pinned = pinnedSlug === f.slug;
          return (
            <button
              key={f.slug}
              type="button"
              onClick={() => setPinnedSlug(pinned ? null : f.slug)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-opacity ${
                pinnedSlug && !pinned
                  ? "border-ink/8 opacity-50"
                  : "border-ink/15"
              }`}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: color }}
              />
              <span className="text-ink">{f.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChartCanvas({
  history,
  topFrontends,
  tailFrontends,
  metric,
  pinnedSlug,
}: {
  history: HlHistorySummary;
  topFrontends: HlHistoryFrontendCompact[];
  tailFrontends: HlHistoryFrontendCompact[];
  metric: Metric;
  pinnedSlug: string | null;
}) {
  const W = 1100;
  const H = 360;
  const PAD_L = 68;
  const PAD_R = 20;
  const PAD_T = 20;
  const PAD_B = 44;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const stepMs = history.step * 1000;
  const t0 = history.t0;

  const seriesOf = (f: HlHistoryFrontendCompact): (number | null)[] =>
    metric === "fees" ? f.fees : f.volume;

  const timestampAt = (f: HlHistoryFrontendCompact, i: number): number =>
    t0 + stepMs * (f.firstIdx + i);

  // Shared time axis: derive from the compact envelope. Longest series =
  // t0 → t0 + step*(maxFirstIdx + maxLen - 1). Fall back to (t0, t0+step)
  // so the SVG still lays out on an empty payload.
  const tRange = useMemo(() => {
    let tMin = Number.POSITIVE_INFINITY;
    let tMax = Number.NEGATIVE_INFINITY;
    const all = [...topFrontends, ...tailFrontends];
    for (const f of all) {
      const s = seriesOf(f);
      if (s.length === 0) continue;
      const first = timestampAt(f, 0);
      const last = timestampAt(f, s.length - 1);
      if (first < tMin) tMin = first;
      if (last > tMax) tMax = last;
    }
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMin === tMax) {
      return { tMin: t0, tMax: t0 + stepMs };
    }
    return { tMin, tMax };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topFrontends, tailFrontends, metric, t0, stepMs]);

  const yMax = useMemo(() => {
    let m = 0;
    const all = [...topFrontends, ...tailFrontends];
    for (const f of all) {
      for (const v of seriesOf(f)) {
        if (v !== null && v > m) m = v;
      }
    }
    return niceLogMax(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topFrontends, tailFrontends, metric]);

  // Log10 scale on the Y axis. We compress the value into log space via
  // log10(v + 1) so v === 0 maps cleanly to 0 (no −∞) and the +1 offset
  // is negligible once we hit even $10. Effective floor is 1 (log10(1+1)
  // ≈ 0.30), which keeps sub-$1 noise off the axis. Long-tail frontends
  // in the $100–$10k range now get vertical breathing room next to the
  // $1M+ leaders instead of collapsing into the zero line.
  const logMin = 0; // log10(0 + 1) = 0
  const logMax = Math.log10(yMax + 1);
  const logDen = logMax - logMin || 1;

  const xFor = (t: number) => {
    const span = tRange.tMax - tRange.tMin || 1;
    return PAD_L + ((t - tRange.tMin) / span) * plotW;
  };
  const yFor = (v: number) => {
    const clamped = v > 0 ? v : 0;
    const norm = (Math.log10(clamped + 1) - logMin) / logDen;
    return PAD_T + plotH * (1 - norm);
  };

  // Multi-segment path: break the line whenever we hit a null so the
  // chart shows gaps rather than a straight fall to zero + spike back.
  const pathFor = (f: HlHistoryFrontendCompact): string => {
    const s = seriesOf(f);
    const parts: string[] = [];
    let inSegment = false;
    for (let i = 0; i < s.length; i++) {
      const v = s[i];
      if (v === null) {
        inSegment = false;
        continue;
      }
      const cmd = inSegment ? "L" : "M";
      const t = timestampAt(f, i);
      parts.push(`${cmd} ${xFor(t).toFixed(1)} ${yFor(v).toFixed(1)}`);
      inSegment = true;
    }
    return parts.join(" ");
  };

  // Power-of-10 gridlines from $1 → yMax. Log axis needs decade ticks
  // (not evenly spaced fractions) so the reader can eyeball orders of
  // magnitude directly.
  const yTicks = useMemo(() => buildLogTicks(yMax), [yMax]);
  const monthTicks = useMemo(
    () => buildMonthTicks(tRange.tMin, tRange.tMax),
    [tRange.tMin, tRange.tMax],
  );

  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const onMove: React.PointerEventHandler<SVGSVGElement> = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const px = xRatio * W;
    if (px < PAD_L || px > W - PAD_R) {
      setHoverT(null);
      return;
    }
    const span = tRange.tMax - tRange.tMin;
    const t = tRange.tMin + ((px - PAD_L) / plotW) * span;
    setHoverT(t);
  };

  // Snap hover to nearest sample per frontend for the tooltip readout.
  // Only the coloured top-N surface in the tooltip; a 98-line list would
  // be unreadable.
  const hoverRows = useMemo(() => {
    if (hoverT === null) return null;
    const rows: { slug: string; name: string; color: string; v: number | null }[] = [];
    for (let i = 0; i < topFrontends.length; i++) {
      const f = topFrontends[i];
      const s = seriesOf(f);
      if (s.length === 0) {
        rows.push({ slug: f.slug, name: f.name, color: COLORS[i % COLORS.length], v: null });
        continue;
      }
      let bestIdx = 0;
      let bestDist = Math.abs(timestampAt(f, 0) - hoverT);
      for (let j = 1; j < s.length; j++) {
        const d = Math.abs(timestampAt(f, j) - hoverT);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = j;
        }
      }
      rows.push({
        slug: f.slug,
        name: f.name,
        color: COLORS[i % COLORS.length],
        v: s[bestIdx] ?? null,
      });
    }
    rows.sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverT, topFrontends, metric, t0, stepMs]);

  const hoverX = hoverT !== null ? xFor(hoverT) : null;
  const hoverDate = hoverT !== null ? formatDate(hoverT) : null;

  return (
    <div className="relative w-full overflow-hidden">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full h-[320px] sm:h-[360px]"
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHoverT(null)}
      >
        {yTicks.map((v) => {
          const y = yFor(v);
          const isFloor = v <= 1;
          return (
            <g key={v}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y}
                y2={y}
                stroke="currentColor"
                className="text-ink/8"
                strokeWidth={1}
                strokeDasharray={isFloor ? "0" : "2 4"}
              />
              <text
                x={PAD_L - 8}
                y={y + 3}
                textAnchor="end"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
                className="fill-ink-faint text-[10px] tabular-nums"
              >
                {fmtUSDShort(v)}
              </text>
            </g>
          );
        })}

        {monthTicks.map((mt) => {
          const x = xFor(mt.t);
          if (x < PAD_L - 1 || x > W - PAD_R + 1) return null;
          return (
            <g key={mt.t}>
              <line
                x1={x}
                x2={x}
                y1={PAD_T + plotH}
                y2={PAD_T + plotH + 4}
                stroke="currentColor"
                className="text-ink/20"
                strokeWidth={1}
              />
              <text
                x={x}
                y={H - PAD_B + 18}
                textAnchor="middle"
                style={{ fontFamily: "var(--font-mono, monospace)" }}
                className="fill-ink-faint text-[10px] tabular-nums"
              >
                {mt.label}
              </text>
            </g>
          );
        })}

        {/* Long-tail grey overlay. Drawn first so the coloured top-N
             paints above it. Kept as one class + one stroke so the DOM
             stays cheap even with ~80 extra paths. */}
        {tailFrontends.map((f) => (
          <path
            key={f.slug}
            d={pathFor(f)}
            fill="none"
            stroke="#9ca3af"
            strokeWidth={1}
            strokeOpacity={pinnedSlug ? 0.05 : 0.1}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transition: "stroke-opacity 120ms ease-out" }}
          />
        ))}

        {topFrontends.map((f, i) => {
          const color = COLORS[i % COLORS.length];
          const dimmed = pinnedSlug !== null && pinnedSlug !== f.slug;
          return (
            <path
              key={f.slug}
              d={pathFor(f)}
              fill="none"
              stroke={color}
              strokeWidth={pinnedSlug === f.slug ? 2.4 : 1.6}
              strokeOpacity={dimmed ? 0.15 : 0.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transition: "stroke-opacity 120ms ease-out" }}
            />
          );
        })}

        {hoverX !== null && (
          <line
            x1={hoverX}
            x2={hoverX}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="currentColor"
            className="text-ink/25"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}
      </svg>

      {hoverRows && hoverDate && hoverX !== null && (
        <Tooltip
          rows={hoverRows}
          date={hoverDate}
          xFrac={hoverX / W}
        />
      )}
    </div>
  );
}

function Tooltip({
  rows,
  date,
  xFrac,
}: {
  rows: { slug: string; name: string; color: string; v: number | null }[];
  date: string;
  xFrac: number;
}) {
  const left = Math.max(4, Math.min(96, xFrac * 100));
  const flipX = left > 55;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-lg border border-ink/15 bg-paper shadow-lg px-3 py-2 text-[11.5px]"
      style={{
        left: `${left}%`,
        top: 8,
        transform: `translateX(${flipX ? "-100%" : "0%"}) translateX(${flipX ? -8 : 8}px)`,
        minWidth: 200,
      }}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {date}
      </p>
      <div className="grid grid-cols-1 gap-0.5">
        {rows.slice(0, 10).map((r) => (
          <div key={r.slug} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 truncate">
              <span
                className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                style={{ background: r.color }}
              />
              <span className="text-ink truncate">{r.name}</span>
            </span>
            <span className="font-semibold tabular-nums">
              {r.v === null ? "—" : fmtUSDShort(r.v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Round up to the next decade for a log-scale ceiling ($10, $100, $1k, …).
 *  Guarantees the topmost gridline is a clean power of 10 so labels never
 *  read `$1.7M` or `$3.4M`. */
function niceLogMax(v: number): number {
  if (!Number.isFinite(v) || v <= 10) return 10;
  return Math.pow(10, Math.ceil(Math.log10(v)));
}

/** Decade gridlines from $1 up through niceLogMax. Small enough (≤ 8
 *  entries for a $10M ceiling) that we don't need mid-decade ticks. */
function buildLogTicks(max: number): number[] {
  const topExp = Math.max(1, Math.ceil(Math.log10(Math.max(max, 10))));
  const out: number[] = [1];
  for (let e = 1; e <= topExp; e++) {
    out.push(Math.pow(10, e));
  }
  return out;
}

function fmtUSDShort(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function formatDate(t: number): string {
  const d = new Date(t);
  return d.toISOString().slice(0, 10);
}

/** First-of-month labels between two epoch-ms bounds. Keeps the count
 *  bounded (~12 labels) so the axis never crowds. */
function buildMonthTicks(
  tMinMs: number,
  tMaxMs: number,
): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  const start = new Date(tMinMs);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  while (cursor.getTime() <= tMaxMs) {
    const t = cursor.getTime();
    if (t >= tMinMs) {
      const label =
        cursor.getUTCMonth() === 0
          ? `${MONTH_NAMES[0]} ${cursor.getUTCFullYear() % 100}`
          : MONTH_NAMES[cursor.getUTCMonth()];
      out.push({ t, label });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}
