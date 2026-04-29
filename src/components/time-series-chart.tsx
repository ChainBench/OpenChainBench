"use client";

import { useMemo, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { lineColor } from "@/lib/series-colors";

type Props = {
  benchmark: Benchmark;
};

type Range = "1h" | "6h" | "24h" | "7d";
const RANGES: Range[] = ["1h", "6h", "24h", "7d"];

const RANGE_HOURS: Record<Range, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
};

/**
 * Multi-line time-series chart with a 1h / 6h / 24h / 7d range selector.
 *
 * - 1h / 6h: tail-slice of the 24h dataset (~3 / ~18 points respectively)
 * - 24h: the full 24h dataset (72 points at 20-min resolution)
 * - 7d: a separate Prometheus query (84 points at 2-hour resolution),
 *   only available when the harness has a deep enough retention.
 */
export function TimeSeriesChart({ benchmark }: Props) {
  const [range, setRange] = useState<Range>("24h");

  const lines = useMemo(() => {
    const built = benchmark.results
      .map((r) => {
        const full = pickSeries(benchmark, r.slug, range);
        return { slug: r.slug, name: r.name, values: full };
      })
      .filter((l) => l.values.length > 0);

    built.sort(
      (a, b) => mean(b.values.slice(-6)) - mean(a.values.slice(-6))
    );
    return built;
  }, [benchmark, range]);

  const has7d = !!benchmark.extras.series7d && Object.keys(benchmark.extras.series7d).length > 0;

  return (
    <figure className="my-2">
      {/* Range selector */}
      <div className="mb-4 flex items-center gap-1">
        {RANGES.map((r) => {
          const active = r === range;
          const disabled = r === "7d" && !has7d;
          return (
            <button
              key={r}
              type="button"
              onClick={() => !disabled && setRange(r)}
              disabled={disabled}
              className={[
                "rounded px-2.5 py-1 text-[11px] font-mono tabular uppercase tracking-[0.1em] transition-colors",
                active
                  ? "bg-ink text-paper"
                  : "text-ink-muted hover:text-ink hover:bg-paper-soft",
                disabled ? "opacity-40 cursor-not-allowed" : "",
              ].join(" ")}
              title={disabled ? "7-day retention not available yet" : undefined}
            >
              {r}
            </button>
          );
        })}
      </div>

      {lines.length === 0 ? (
        <div className="border-y-2 border-ink py-12 text-center text-ink-muted text-sm">
          No time-series data emitted for this range yet.
        </div>
      ) : (
        <Chart
          lines={lines}
          unit={benchmark.unit}
          windowHours={RANGE_HOURS[range]}
        />
      )}
    </figure>
  );
}

function Chart({
  lines,
  unit,
  windowHours,
}: {
  lines: { slug: string; name: string; values: number[] }[];
  unit: string;
  windowHours: number;
}) {
  const W = 1000;
  const H = 360;
  const padL = 60;
  const padR = 88;
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
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Last ${windowHours} hours`}
      >
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
          const baseY = padT + innerH;
          const fillPath =
            `M ${points[0][0].toFixed(2)},${baseY.toFixed(2)} ` +
            points.map(([x, y]) => `L ${x.toFixed(2)},${y.toFixed(2)}`).join(" ") +
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
              <circle cx={lastX} cy={lastY} r={2.8} fill={color} />
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
    </>
  );
}

function pickSeries(
  benchmark: Benchmark,
  slug: string,
  range: Range
): number[] {
  const s24 = benchmark.extras.series24h[slug] ?? [];
  const s7 = benchmark.extras.series7d?.[slug] ?? [];

  if (range === "7d") return s7;
  if (range === "24h") return s24;
  // 1h / 6h: tail-slice of the 24h dataset (which is 72 points = 20-min res)
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
