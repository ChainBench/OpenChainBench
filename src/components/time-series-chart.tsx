import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { lineColor } from "@/lib/series-colors";

type Props = {
  benchmark: Benchmark;
  windowHours?: number;
};

/**
 * Multi-line time-series chart — every provider's metric over the trailing
 * window plotted on a single canvas. Server-rendered SVG.
 *
 * Each line gets a soft area fill below it to give visual hierarchy without
 * a "winner" marker. Trailing dot + value label at the end of each line so
 * a reader can identify a series without scanning the legend.
 */
export function TimeSeriesChart({ benchmark, windowHours = 24 }: Props) {
  const { results, unit, extras } = benchmark;

  const lines = results
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      values: extras.series24h[r.slug] ?? [],
    }))
    .filter((l) => l.values.length > 0);

  if (lines.length === 0) {
    return (
      <div className="border-y-2 border-ink py-12 text-center text-ink-muted text-sm">
        No time-series data emitted yet.
      </div>
    );
  }

  // Sort by current value so legend reads top-down on the chart and
  // colour assignment is deterministic.
  lines.sort(
    (a, b) =>
      mean(b.values.slice(-6)) - mean(a.values.slice(-6))
  );

  const W = 1000;
  const H = 360;
  const padL = 60;
  const padR = 88; // room for end-of-line labels
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const allValues = lines.flatMap((l) => l.values);
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yPad = (yMax - yMin) * 0.1 || 1;
  const lo = Math.max(0, yMin - yPad);
  const hi = yMax + yPad;
  const yRange = hi - lo;

  const yTickCount = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= yTickCount; i++) yTicks.push(lo + (yRange * i) / yTickCount);

  const xTicks = buildXTicks(windowHours);

  return (
    <figure className="my-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`${benchmark.metric} over the last ${windowHours} hours`}
      >
        {/* Per-provider area-fill gradients */}
        <defs>
          {lines.map((l, idx) => {
            const color = lineColor(idx);
            return (
              <linearGradient
                key={l.slug}
                id={`fill-${l.slug}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={color} stopOpacity="0.10" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            );
          })}
        </defs>

        {/* Y gridlines + tick labels */}
        {yTicks.map((v, i) => {
          const y = padT + innerH * (1 - (v - lo) / yRange);
          const isBound = i === 0 || i === yTickCount;
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

        {/* Lines + area fills */}
        {lines.map((l, idx) => {
          const color = lineColor(idx);
          const points = l.values.map((v, i) => {
            const x = padL + innerW * (i / Math.max(1, l.values.length - 1));
            const y = padT + innerH * (1 - (v - lo) / yRange);
            return [x, y] as const;
          });
          const linePath = points
            .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
            .join(" ");
          // Closed polygon for the fill: line + bottom-right + bottom-left
          const baseY = padT + innerH;
          const fillPath =
            `M ${points[0][0].toFixed(2)},${baseY.toFixed(2)} ` +
            points
              .map(([x, y]) => `L ${x.toFixed(2)},${y.toFixed(2)}`)
              .join(" ") +
            ` L ${points[points.length - 1][0].toFixed(2)},${baseY.toFixed(2)} Z`;

          const last = l.values[l.values.length - 1];
          const lastX = padL + innerW;
          const lastY = padT + innerH * (1 - (last - lo) / yRange);

          return (
            <g key={l.slug}>
              <path d={fillPath} fill={`url(#fill-${l.slug})`} />
              <polyline
                fill="none"
                stroke={color}
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                points={linePath}
              />
              {/* Tail dot */}
              <circle cx={lastX} cy={lastY} r={2.8} fill={color} />
              {/* End-of-line provider label + value */}
              <text
                x={lastX + 8}
                y={lastY}
                dominantBaseline="middle"
                fontFamily="var(--font-sans)"
                fontSize="11"
                fontWeight="500"
                fill={color}
              >
                {l.name}
              </text>
              <text
                x={lastX + 8}
                y={lastY + 12}
                dominantBaseline="middle"
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {fmtUnit(last, unit)}
              </text>
            </g>
          );
        })}

        {/* Vertical "now" guide */}
        <line
          x1={padL + innerW}
          x2={padL + innerW}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--color-rule)"
          strokeWidth={0.8}
          strokeDasharray="2 3"
        />

        {/* Outer Y axis */}
        <line
          x1={padL}
          x2={padL}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--color-ink)"
          strokeWidth={1}
        />
      </svg>

      {/* Compact legend below — sorted current → low */}
      <ul className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-3">
        {lines.map((l, idx) => {
          const color = lineColor(idx);
          const last = l.values[l.values.length - 1];
          return (
            <li
              key={l.slug}
              className="inline-flex items-center gap-2 text-[12px]"
            >
              <span
                className="inline-block h-px w-5"
                style={{ background: color }}
              />
              <span className="text-ink font-medium">{l.name}</span>
              <span className="font-mono tabular text-ink-muted text-[11px]">
                {fmtUnit(last, unit)}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function buildXTicks(windowHours: number) {
  const ticks: { pct: number; label: string }[] = [];
  const step = 0.25;
  for (let p = 0; p <= 1; p += step) {
    const hoursAgo = Math.round(windowHours * (1 - p));
    const label = hoursAgo === 0 ? "now" : `−${hoursAgo}h`;
    ticks.push({ pct: p, label });
  }
  return ticks;
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
