"use client";

import { useMemo, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";

type Props = {
  benchmark: Benchmark;
};

type Range = "1h" | "6h" | "24h" | "7d";
const RANGES: Range[] = ["1h", "6h", "24h", "7d"];
const RANGE_HOURS: Record<Range, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 };

export function SmallMultiplesChart({ benchmark }: Props) {
  const [range, setRange] = useState<Range>("24h");

  const has7d =
    !!benchmark.extras.series7d &&
    Object.keys(benchmark.extras.series7d).length > 0;

  const colors = useMemo(
    () => buildProviderColors(benchmark.results),
    [benchmark.results]
  );

  const cells = useMemo(() => {
    return benchmark.results
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        color: colors.get(r.slug) ?? "var(--color-ink-soft)",
        values: pickSeries(benchmark, r.slug, range),
        currentValue: r.ms.p50,
      }))
      .filter((c) => c.values.length > 0)
      .sort((a, b) => {
        const av = a.values[a.values.length - 1] ?? a.currentValue;
        const bv = b.values[b.values.length - 1] ?? b.currentValue;
        return benchmark.higherIsBetter ? bv - av : av - bv;
      });
  }, [benchmark, range, colors]);

  return (
    <figure className="my-2">
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

      {cells.length === 0 ? (
        <div className="border-y-2 border-ink py-12 text-center text-ink-muted text-sm">
          No time-series data emitted for this range yet.
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {cells.map((c) => (
            <Cell
              key={c.slug}
              name={c.name}
              color={c.color}
              values={c.values}
              unit={benchmark.unit}
            />
          ))}
        </div>
      )}
    </figure>
  );
}

function Cell({
  name,
  color,
  values,
  unit,
}: {
  name: string;
  color: string;
  values: number[];
  unit: string;
}) {
  const W = 200;
  const H = 60;
  const padX = 4;
  const padY = 6;
  const innerW = W - 2 * padX;
  const innerH = H - 2 * padY;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const pts = values.map((v, i) => {
    const x = padX + innerW * (i / Math.max(1, values.length - 1));
    const y = padY + innerH * (1 - (v - min) / range);
    return [x, y] as const;
  });

  const linePath = pts
    .map(([x, y], i) =>
      i === 0 ? `M ${x.toFixed(1)},${y.toFixed(1)}` : `L ${x.toFixed(1)},${y.toFixed(1)}`
    )
    .join(" ");

  const fillPath =
    `M ${pts[0][0].toFixed(1)},${(padY + innerH).toFixed(1)} ` +
    pts.map(([x, y]) => `L ${x.toFixed(1)},${y.toFixed(1)}`).join(" ") +
    ` L ${pts[pts.length - 1][0].toFixed(1)},${(padY + innerH).toFixed(1)} Z`;

  const last = values[values.length - 1];
  const lastX = pts[pts.length - 1][0];
  const lastY = pts[pts.length - 1][1];

  return (
    <div className="border border-rule rounded p-3 bg-paper-soft/40 hover:bg-paper-soft/80 transition-colors">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span
          className="text-[12px] font-medium text-ink truncate"
          style={{ color }}
        >
          {name}
        </span>
        <span className="font-mono tabular text-[11px] text-ink-soft shrink-0">
          {fmtUnit(last, unit)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto">
        <defs>
          <linearGradient id={`smfill-${name}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.15" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fillPath} fill={`url(#smfill-${name})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={lastX} cy={lastY} r={2.2} fill={color} />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] font-mono tabular text-ink-faint">
        <span>min {fmtUnit(min, unit)}</span>
        <span>max {fmtUnit(max, unit)}</span>
      </div>
    </div>
  );
}

function pickSeries(benchmark: Benchmark, slug: string, range: Range): number[] {
  const s24 = benchmark.extras.series24h[slug] ?? [];
  const s7 = benchmark.extras.series7d?.[slug] ?? [];
  if (range === "7d") return s7;
  if (range === "24h") return s24;
  const ratio = RANGE_HOURS[range] / 24;
  const take = Math.max(2, Math.round(s24.length * ratio));
  return s24.slice(-take);
}
