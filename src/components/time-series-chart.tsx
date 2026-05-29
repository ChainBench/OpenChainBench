"use client";

import { useMemo, useRef, useState } from "react";
import { Globe } from "lucide-react";
import type { Benchmark } from "@/types/benchmark";
import { brandColor } from "@/lib/brand";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { LiveDot } from "@/components/live-dot";

type Props = {
  benchmark: Benchmark;
  /** Optional externally-controlled region. When provided, the chart
   *  filters its lines by this value and hides its internal region tabs
   *  (the parent component renders them in a shared dimension row). */
  region?: string;
  /** Optional slot rendered in the chart's header row, right-aligned. */
  headerActions?: import("react").ReactNode;
};

type Range = "1h" | "6h" | "24h" | "7d" | "30d";
const RANGES: Range[] = ["1h", "6h", "24h", "7d", "30d"];

const RANGE_HOURS: Record<Range, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

const RANGE_LABEL: Record<Range, string> = {
  "1h": "last hour",
  "6h": "last 6 hours",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

const REGION_LABEL: Record<string, string> = {
  "us-east": "US-East",
  "eu-west": "EU-West",
  "ap-southeast": "AP-Southeast",
  global: "Global",
};

export function TimeSeriesChart({ benchmark, region: regionProp, headerActions }: Props) {
  const [range, setRange] = useState<Range>("24h");
  const [regionLocal, setRegionLocal] = useState<string>("all");
  const region = regionProp ?? regionLocal;
  const setRegion = regionProp != null ? () => {} : setRegionLocal;

  const has7d =
    !!benchmark.extras.series7d &&
    Object.keys(benchmark.extras.series7d).length > 0;

  const has30d =
    !!benchmark.extras.series30d &&
    Object.keys(benchmark.extras.series30d).length > 0;

  const availableRegions = useMemo(() => {
    const set = new Set<string>();
    const byRegion = benchmark.extras.seriesByRegion24h ?? {};
    for (const slug of Object.keys(byRegion)) {
      for (const r of Object.keys(byRegion[slug])) set.add(r);
    }
    return Array.from(set).sort();
  }, [benchmark]);

  // Internal region tabs are hidden when the parent controls the region -
  // it renders a unified Chain + Region row above and passes the value down.
  const showRegionTabs = regionProp == null && availableRegions.length > 1;

  const colors = useMemo(
    () => buildProviderColors(benchmark.results),
    [benchmark.results]
  );

  const lines = useMemo(() => {
    const built = benchmark.results
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        color: colors.get(r.slug) ?? "var(--color-ink-soft)",
        values: pickSeries(benchmark, r.slug, range, region),
      }))
      .filter((l) => l.values.length > 0);

    built.sort((a, b) => mean(b.values.slice(-6)) - mean(a.values.slice(-6)));
    return built;
  }, [benchmark, range, region, colors]);

  // A key that flips when the data shape changes. used to retrigger
  // the line-draw animation.
  const seriesKey = `${range}::${region}`;

  return (
    <figure className="my-2">
      <div className="mb-3 flex items-center justify-between gap-3 min-h-7">
        <p className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          <LiveDot />
          <span>
            {benchmark.metric} · {RANGE_LABEL[range]}
          </span>
        </p>
        {headerActions}
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {RANGES.map((r) => {
            const active = r === range;
            const disabled =
              (r === "7d" && !has7d) || (r === "30d" && !has30d);
            return (
              <button
                key={r}
                type="button"
                onClick={() => !disabled && setRange(r)}
                disabled={disabled}
                className={[
                  "rounded px-2.5 py-1 text-[11px] font-sans tabular uppercase tracking-[0.1em] font-medium transition-colors",
                  active
                    ? "bg-ink text-paper"
                    : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                  disabled ? "opacity-40 cursor-not-allowed" : "",
                ].join(" ")}
                title={
                  disabled
                    ? `${r} retention not available yet`
                    : undefined
                }
              >
                {r}
              </button>
            );
          })}
        </div>

        {showRegionTabs && (
          <div className="flex items-center gap-1">
            <span className="mr-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              Region
            </span>
            <RegionTab
              slug="all"
              label="All"
              active={region === "all"}
              onClick={() => setRegion("all")}
            />
            {availableRegions.map((r) => (
              <RegionTab
                key={r}
                slug={r}
                label={REGION_LABEL[r] ?? r}
                active={region === r}
                onClick={() => setRegion(r)}
              />
            ))}
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <div className="border-y-2 border-ink py-12 text-center text-ink-muted text-sm">
          No time-series data emitted for this range yet.
        </div>
      ) : (
        <Chart
          key={seriesKey}
          lines={lines as LineWithColor[]}
          unit={benchmark.unit}
          windowHours={RANGE_HOURS[range]}
        />
      )}
    </figure>
  );
}

function RegionTab({
  slug,
  label,
  active,
  onClick,
}: {
  slug: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const accent = brandColor(slug);
  const activeStyle = active
    ? { background: accent ?? "var(--color-ink)", color: "var(--color-paper)" }
    : undefined;
  const className = active
    ? "rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] shadow-sm transition-colors"
    : "rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] border border-rule text-ink-muted hover:text-ink hover:bg-paper-soft transition-colors";
  return (
    <button type="button" onClick={onClick} style={activeStyle} className={className}>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-flex items-center justify-center rounded-full"
          style={{
            width: 14,
            height: 14,
            background: active ? "rgba(255,255,255,0.18)" : (accent ?? "var(--color-ink-soft)"),
            color: "var(--color-paper)",
          }}
        >
          <Globe size={9} strokeWidth={2.2} />
        </span>
        {label}
      </span>
    </button>
  );
}

type LineWithColor = {
  slug: string;
  name: string;
  color: string;
  values: number[];
};

function Chart({
  lines,
  unit,
  windowHours,
}: {
  lines: LineWithColor[];
  unit: string;
  windowHours: number;
}) {
  const W = 1000;
  const H = 360;
  const padL = 60;
  const padR = 96;
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const allValues = lines.flatMap((l) => l.values);
  const dataMin = Math.min(...allValues);
  const dataMax = Math.max(...allValues);
  const { lo, hi, yTicks } = niceTicks(dataMin, dataMax, 4);
  const yRange = hi - lo;

  const xTicks = buildXTicks(windowHours);
  const numPoints = Math.max(...lines.map((l) => l.values.length));

  // Hover state
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    idx: number;
    xPx: number;
    yPx: number;
  } | null>(null);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const xVB = (xPx / rect.width) * W;
    if (xVB < padL || xVB > W - padR || numPoints < 2) {
      setHover(null);
      return;
    }
    const ratio = (xVB - padL) / innerW;
    const idx = Math.max(
      0,
      Math.min(numPoints - 1, Math.round(ratio * (numPoints - 1)))
    );
    setHover({ idx, xPx, yPx });
  };

  // Per-line drawn paths (memoised for animation re-trigger via key).
  // Treats hard zeroes among non-zero data as gaps (no-data) rather than
  // drawing the line down to zero. A sustained outage shows as a missing
  // segment instead of a misleading "0%" cliff.
  const drawn = useMemo(() => {
    return lines.map((l) => {
      const color = l.color;
      const positive = l.values.filter((v) => v > 0);
      const positiveMin = positive.length > 0 ? Math.min(...positive) : 0;
      const isGap = (v: number) => !Number.isFinite(v) || (v === 0 && positiveMin > 1);

      const pts = l.values.map((v, i) => {
        const x = padL + innerW * (i / Math.max(1, l.values.length - 1));
        const y = padT + innerH * (1 - (v - lo) / yRange);
        return { x, y, gap: isGap(v) } as const;
      });

      // Build line path with `M` at gap boundaries to break the stroke.
      let linePath = "";
      let openingSegment = true;
      for (const p of pts) {
        if (p.gap) {
          openingSegment = true;
          continue;
        }
        const cmd = openingSegment ? "M" : "L";
        linePath += `${cmd} ${p.x.toFixed(2)},${p.y.toFixed(2)} `;
        openingSegment = false;
      }
      linePath = linePath.trim();

      // Fill path uses the same gap logic - closes at base on each break.
      const baseY = padT + innerH;
      let fillPath = "";
      let segStart: { x: number; y: number } | null = null;
      const closeSegment = (endX: number) => {
        if (segStart) {
          fillPath += `L ${endX.toFixed(2)},${baseY.toFixed(2)} Z `;
          segStart = null;
        }
      };
      for (const p of pts) {
        if (p.gap) {
          // close current segment at the last drawn x
          // (the previous point's x - but we only know prev via state)
          continue;
        }
        if (!segStart) {
          fillPath += `M ${p.x.toFixed(2)},${baseY.toFixed(2)} L ${p.x.toFixed(2)},${p.y.toFixed(2)} `;
          segStart = { x: p.x, y: p.y };
        } else {
          fillPath += `L ${p.x.toFixed(2)},${p.y.toFixed(2)} `;
        }
      }
      // Close any open segment at its last x
      const lastDrawn = [...pts].reverse().find((p) => !p.gap);
      if (lastDrawn) closeSegment(lastDrawn.x);

      // End-of-line label uses the last non-gap value.
      const last = lastDrawn ? l.values[pts.indexOf(lastDrawn)] : 0;
      const lastX = lastDrawn ? lastDrawn.x : padL + innerW;
      const lastY = lastDrawn ? lastDrawn.y : padT + innerH;
      return { ...l, color, pts, linePath, fillPath, lastX, lastY, last };
    });
  }, [lines, padL, padR, padT, padB, innerW, innerH, lo, yRange]);

  const hoverX = hover ? padL + innerW * (hover.idx / Math.max(1, numPoints - 1)) : null;
  const hoverFraction = hover ? hover.idx / Math.max(1, numPoints - 1) : 0;
  const hoverHoursAgo = hover ? windowHours * (1 - hoverFraction) : 0;

  // Tooltip layout (sorted by value at hover, descending)
  const tooltipRows = useMemo(() => {
    if (!hover) return null;
    return [...drawn]
      .map((d) => ({ ...d, value: d.values[hover.idx] ?? d.last }))
      .filter((d) => Number.isFinite(d.value))
      .sort((a, b) => b.value - a.value);
  }, [drawn, hover]);

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full h-auto"
        role="img"
        aria-label={`Last ${windowHours} hours`}
      >
        <defs>
          {drawn.map((d) => (
            <linearGradient
              key={d.slug}
              id={`fill-${d.slug}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={d.color} stopOpacity="0.10" />
              <stop offset="100%" stopColor={d.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Y gridlines + tick labels */}
        {yTicks.map((v, i) => {
          const y = padT + innerH * (1 - (v - lo) / yRange);
          const isBound = i === 0 || i === yTicks.length - 1;
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="var(--color-rule)"
                strokeWidth={isBound ? 1 : 0.5}
                strokeDasharray={isBound ? "0" : "2 4"}
              />
              <text
                x={padL - 8}
                y={y}
                dominantBaseline="middle"
                textAnchor="end"
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {fmtTick(v, unit)}
              </text>
            </g>
          );
        })}

        {/* X tick labels */}
        {xTicks.map((t, i) => {
          const x = padL + innerW * t.pct;
          return (
            <g key={i}>
              <line
                x1={x}
                x2={x}
                y1={padT + innerH}
                y2={padT + innerH + 4}
                stroke="var(--color-rule)"
                strokeWidth={0.8}
              />
              <text
                x={x}
                y={padT + innerH + 18}
                textAnchor={
                  i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"
                }
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {t.label}
              </text>
            </g>
          );
        })}

        {/* Areas + lines */}
        {drawn.map((d) => {
          const dimmed = hover && hover.idx >= 0; // when hovering, slightly mute non-hovered? No, keep all visible.
          void dimmed;
          return (
            <g key={d.slug} className="ts-line">
              <path d={d.fillPath} fill={`url(#fill-${d.slug})`} />
              <path
                d={d.linePath}
                fill="none"
                stroke={d.color}
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                strokeDasharray="1"
                style={{
                  // Trigger draw-in via CSS animation
                  animation: "ts-draw 0.7s ease-out forwards",
                }}
              />
              {/* Live pulse halo. animated outward */}
              <circle cx={d.lastX} cy={d.lastY} r={3} fill={d.color} opacity={0.4}>
                <animate
                  attributeName="r"
                  values="3;10;3"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.45;0;0.45"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              </circle>
              {/* Trailing tail dot */}
              <circle cx={d.lastX} cy={d.lastY} r={2.8} fill={d.color} />
              {/* End-of-line label */}
              <text
                x={d.lastX + 8}
                y={d.lastY}
                dominantBaseline="middle"
                fontFamily="var(--font-sans)"
                fontSize="11"
                fontWeight="500"
                fill={d.color}
              >
                {d.name}
              </text>
              <text
                x={d.lastX + 8}
                y={d.lastY + 12}
                dominantBaseline="middle"
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {fmtUnit(d.last, unit)}
              </text>
            </g>
          );
        })}

        {/* Crosshair + hover dots */}
        {hover && hoverX != null && (
          <g style={{ pointerEvents: "none" }}>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={padT}
              y2={padT + innerH}
              stroke="var(--color-ink)"
              strokeWidth={0.8}
              strokeDasharray="2 3"
              opacity={0.5}
            />
            {drawn.map((d) => {
              const v = d.values[hover.idx];
              if (!Number.isFinite(v)) return null;
              const cy = padT + innerH * (1 - (v - lo) / yRange);
              return (
                <g key={d.slug}>
                  <circle
                    cx={hoverX}
                    cy={cy}
                    r={4}
                    fill="var(--color-paper)"
                    stroke={d.color}
                    strokeWidth={1.8}
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* "now" guide and Y-axis */}
        <line
          x1={padL + innerW}
          x2={padL + innerW}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--color-rule)"
          strokeWidth={0.8}
          strokeDasharray="2 3"
        />
        <line
          x1={padL}
          x2={padL}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--color-ink)"
          strokeWidth={1}
        />
      </svg>

      {/* Floating tooltip */}
      {hover && tooltipRows && tooltipRows.length > 0 && (
        <Tooltip
          xPx={hover.xPx}
          yPx={hover.yPx}
          containerW={wrapRef.current?.getBoundingClientRect().width ?? 1}
          hoursAgo={hoverHoursAgo}
          windowHours={windowHours}
          unit={unit}
          rows={tooltipRows}
        />
      )}

      {/* Compact legend below chart */}
      <ul className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-3">
        {drawn.map((d) => (
          <li
            key={d.slug}
            className="inline-flex items-center gap-2 text-[12px]"
          >
            <span
              className="inline-block h-px w-5"
              style={{ background: d.color }}
            />
            <span className="text-ink font-medium">{d.name}</span>
            <span className="font-sans tabular text-ink-muted text-[11px]">
              {fmtUnit(d.last, unit)}
            </span>
          </li>
        ))}
      </ul>

      {/* CSS animations */}
      <style>{`
        @keyframes ts-draw {
          from { stroke-dashoffset: 1; }
          to   { stroke-dashoffset: 0; }
        }
        .ts-line path[d] { transition: opacity 0.2s ease; }
      `}</style>
    </div>
  );
}

function Tooltip({
  xPx,
  yPx,
  containerW,
  hoursAgo,
  windowHours,
  unit,
  rows,
}: {
  xPx: number;
  yPx: number;
  containerW: number;
  hoursAgo: number;
  windowHours: number;
  unit: string;
  rows: {
    slug: string;
    name: string;
    color: string;
    value: number;
  }[];
}) {
  // Flip the tooltip to the left of the cursor when near the right edge
  const flipLeft = xPx > containerW * 0.6;
  const offsetX = 14;
  const left = flipLeft ? undefined : xPx + offsetX;
  const right = flipLeft ? containerW - xPx + offsetX : undefined;

  // Anchor tooltip vertically to top of visible area but follow cursor a bit
  const top = Math.max(8, Math.min(yPx - 28, 320));

  return (
    <div
      className="pointer-events-none absolute z-10"
      style={{
        left,
        right,
        top,
      }}
    >
      <div
        className="rounded border border-rule bg-paper-soft/95 backdrop-blur-sm shadow-[0_12px_28px_-16px_rgba(28,26,23,0.25)] px-3 py-2.5 min-w-[12rem] sm:min-w-[14rem] max-w-[calc(100vw-2rem)] text-[11px]"
        style={{
          animation: "ts-tooltip-in 0.15s ease-out forwards",
        }}
      >
        <p className="font-sans tabular uppercase tracking-[0.12em] text-ink-muted font-medium">
          {formatHoursAgo(hoursAgo, windowHours)}
        </p>
        <ul className="mt-2 space-y-1">
          {rows.map((r) => (
            <li
              key={r.slug}
              className="grid grid-cols-[10px_1fr_auto] items-center gap-2"
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: r.color }}
              />
              <span className="text-ink truncate">{r.name}</span>
              <span className="font-sans tabular text-ink-soft">
                {fmtUnit(r.value, unit)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <style>{`
        @keyframes ts-tooltip-in {
          from { opacity: 0; transform: translateY(2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function pickSeries(
  benchmark: Benchmark,
  slug: string,
  range: Range,
  region: string
): number[] {
  const isAll = region === "all";

  if (!isAll) {
    if (range === "30d") {
      return benchmark.extras.seriesByRegion30d?.[slug]?.[region] ?? [];
    }
    if (range === "7d") {
      return benchmark.extras.seriesByRegion7d?.[slug]?.[region] ?? [];
    }
    const base = benchmark.extras.seriesByRegion24h?.[slug]?.[region] ?? [];
    if (range === "24h") return base;
    const ratio = RANGE_HOURS[range] / 24;
    const take = Math.max(2, Math.round(base.length * ratio));
    return base.slice(-take);
  }

  const s24 = benchmark.extras.series24h[slug] ?? [];
  const s7 = benchmark.extras.series7d?.[slug] ?? [];
  const s30 = benchmark.extras.series30d?.[slug] ?? [];
  if (range === "30d") return s30;
  if (range === "7d") return s7;
  if (range === "24h") return s24;
  const ratio = RANGE_HOURS[range] / 24;
  const take = Math.max(2, Math.round(s24.length * ratio));
  return s24.slice(-take);
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function buildXTicks(windowHours: number) {
  const ticks: { pct: number; label: string }[] = [];
  const step = 0.25;
  for (let p = 0; p <= 1; p += step) {
    const ago = windowHours * (1 - p);
    let label: string;
    if (ago === 0) label = "now";
    else if (windowHours <= 6) {
      const m = Math.round(ago * 60);
      label = `−${m}m`;
    } else if (windowHours <= 48) {
      label = `−${Math.round(ago)}h`;
    } else {
      label = `−${(ago / 24).toFixed(0)}d`;
    }
    ticks.push({ pct: p, label });
  }
  return ticks;
}

function formatHoursAgo(hoursAgo: number, windowHours: number): string {
  if (hoursAgo <= 0.001) return "now";
  if (windowHours <= 6) {
    const m = Math.round(hoursAgo * 60);
    return `−${m} min`;
  }
  if (windowHours <= 48) {
    const h = Math.floor(hoursAgo);
    const m = Math.round((hoursAgo - h) * 60);
    if (h === 0) return `−${m} min`;
    return m > 0 ? `−${h}h ${m}m` : `−${h}h`;
  }
  const d = Math.floor(hoursAgo / 24);
  const h = Math.round(hoursAgo - d * 24);
  return d === 0 ? `−${h}h` : h > 0 ? `−${d}d ${h}h` : `−${d}d`;
}

// niceTicks picks rounded y-axis bounds + tick values so labels read as
// 0%, 25%, 50%, 75%, 100% rather than 18.2%, 36.4%, 54.6%, 72.8%.
function niceTicks(
  dataMin: number,
  dataMax: number,
  targetCount: number
): { lo: number; hi: number; yTicks: number[] } {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
    return { lo: 0, hi: 1, yTicks: [0, 0.25, 0.5, 0.75, 1] };
  }
  if (dataMin === dataMax) {
    const v = dataMin;
    return { lo: v - 1, hi: v + 1, yTicks: [v - 1, v, v + 1] };
  }
  const rawSpan = dataMax - dataMin;
  const rawStep = rawSpan / targetCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  // Pick the smallest "nice" step >= raw step. 1, 2, 2.5, 5, 10
  let niceStep: number;
  if (norm <= 1) niceStep = 1;
  else if (norm <= 2) niceStep = 2;
  else if (norm <= 2.5) niceStep = 2.5;
  else if (norm <= 5) niceStep = 5;
  else niceStep = 10;
  niceStep *= mag;
  const lo = Math.max(0, Math.floor(dataMin / niceStep) * niceStep);
  const hi = Math.ceil(dataMax / niceStep) * niceStep;
  const yTicks: number[] = [];
  for (let v = lo; v <= hi + niceStep / 2; v += niceStep) yTicks.push(v);
  return { lo, hi, yTicks };
}

function fmtTick(v: number, unit: string) {
  if (v === 0) return "0";
  if (unit === "pct") {
    if (v >= 1) return `${v.toFixed(1)}%`;
    if (v >= 0.1) return `${v.toFixed(2)}%`;
    return `${v.toFixed(3)}%`;
  }
  if (unit === "bps") {
    const pct = v / 100;
    if (pct >= 1) return `${pct.toFixed(1)}%`;
    return `${pct.toFixed(2)}%`;
  }
  if (unit === "s") {
    const s = v / 1000;
    if (s >= 60) return `${(s / 60).toFixed(0)}m`;
    return `${s.toFixed(s >= 10 ? 0 : 1)}s`;
  }
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
}

