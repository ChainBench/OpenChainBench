import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { lineColor } from "@/lib/series-colors";

type Props = {
  benchmark: Benchmark;
  /** Window in hours the series spans. Default 24. */
  windowHours?: number;
};

/**
 * Multi-line time-series chart — every provider's p50 over the trailing
 * window plotted on a single canvas. The "Grafana view" of the dataset:
 * proper time axis, value axis, gridlines, legend.
 *
 * Server-rendered SVG. No interactivity for now (hover tooltips would
 * require a client component); the static rendering is sharp on every
 * load thanks to ISR.
 */
export function TimeSeriesChart({ benchmark, windowHours = 24 }: Props) {
  const { results, unit, extras } = benchmark;

  // Build provider lines, drop empty series
  const lines = results
    .map((r) => ({ slug: r.slug, name: r.name, values: extras.series24h[r.slug] ?? [] }))
    .filter((l) => l.values.length > 0);

  if (lines.length === 0) {
    return (
      <div className="border-y-2 border-ink py-12 text-center text-ink-muted text-sm">
        No time-series data emitted yet.
      </div>
    );
  }

  // Sort lines by their final-window mean (ascending) so colours and
  // legend ordering are deterministic and reflect the current ranking.
  lines.sort(
    (a, b) =>
      mean(a.values.slice(-12)) - mean(b.values.slice(-12))
  );

  // Layout
  const W = 1000;
  const H = 320;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Y bounds across all lines
  const allValues = lines.flatMap((l) => l.values);
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yPad = (yMax - yMin) * 0.08 || 1;
  const lo = Math.max(0, yMin - yPad);
  const hi = yMax + yPad;
  const yRange = hi - lo;

  // Y ticks (4)
  const yTickCount = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= yTickCount; i++) {
    yTicks.push(lo + (yRange * i) / yTickCount);
  }

  // X ticks (every 6 hours over a 24h window)
  const xTicks = buildXTicks(windowHours);

  return (
    <figure className="my-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`${benchmark.metric} over the last ${windowHours} hours`}
      >
        {/* Y gridlines + tick labels */}
        {yTicks.map((v, i) => {
          const y = padT + innerH * (1 - (v - lo) / yRange);
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="var(--color-rule)"
                strokeWidth={i === 0 || i === yTickCount ? 1 : 0.5}
                strokeDasharray={i === 0 || i === yTickCount ? "0" : "2 4"}
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

        {/* X tick labels along the bottom rule */}
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
                textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {t.label}
              </text>
            </g>
          );
        })}

        {/* Lines */}
        {lines.map((l, idx) => {
          const color = lineColor(idx);
          const pts = l.values
            .map((v, i) => {
              const x = padL + innerW * (i / Math.max(1, l.values.length - 1));
              const y = padT + innerH * (1 - (v - lo) / yRange);
              return `${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(" ");
          const last = l.values[l.values.length - 1];
          const lastX = padL + innerW;
          const lastY = padT + innerH * (1 - (last - lo) / yRange);
          return (
            <g key={l.slug}>
              <polyline
                fill="none"
                stroke={color}
                strokeWidth={1.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                points={pts}
              />
              {/* Tail dot for orientation */}
              <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
            </g>
          );
        })}

        {/* Outer rule */}
        <line
          x1={padL}
          x2={padL}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--color-ink)"
          strokeWidth={1}
        />
      </svg>

      {/* Legend */}
      <ul className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {lines.map((l, idx) => {
          const color = lineColor(idx);
          const last = l.values[l.values.length - 1];
          return (
            <li
              key={l.slug}
              className="inline-flex items-center gap-2 text-[12px]"
            >
              <span
                className="inline-block h-px w-4"
                style={{ background: color }}
              />
              <span className="text-ink">{l.name}</span>
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
  // 5 ticks: now, -1/4, -1/2, -3/4, -window
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
