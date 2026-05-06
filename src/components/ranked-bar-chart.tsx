"use client";

import { useMemo } from "react";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";

type Props = { benchmark: Benchmark };

export function RankedBarChart({ benchmark }: Props) {
  const colors = useMemo(
    () => buildProviderColors(benchmark.results),
    [benchmark.results]
  );

  const rows = useMemo(() => {
    const sorted = [...benchmark.results].sort((a, b) =>
      benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50
    );
    return sorted.map((r) => ({
      slug: r.slug,
      name: r.name,
      tag: r.tag,
      value: r.ms.p50,
      color: colors.get(r.slug) ?? "var(--color-ink-soft)",
    }));
  }, [benchmark, colors]);

  const values = rows.map((r) => r.value);
  const maxV = Math.max(...values, 1);
  const minV = Math.min(...values.filter((v) => v > 0), maxV);

  // Use log scale when dynamic range > 50x — typical for finality where
  // sub-second chains coexist with 30-min ones. Linear scale crushes
  // everything below the slowest chain into invisible slivers.
  const useLog = maxV / Math.max(minV, 1) > 50;

  const project = (v: number) => {
    if (!useLog) return Math.max(0, v) / maxV;
    if (v <= 0) return 0;
    const lo = Math.log10(Math.max(1, minV / 2));
    const hi = Math.log10(maxV);
    return Math.max(0, (Math.log10(v) - lo) / (hi - lo));
  };

  return (
    <figure className="my-2">
      <ul className="space-y-2">
        {rows.map((r, idx) => {
          const w = project(r.value);
          return (
            <li
              key={r.slug}
              className="grid grid-cols-[2.5rem_minmax(7rem,11rem)_1fr_auto] items-center gap-3 sm:gap-4"
            >
              <span className="font-mono tabular text-[11px] text-ink-faint text-right">
                #{idx + 1}
              </span>
              <span className="text-[13px] text-ink truncate" title={r.tag}>
                {r.name}
              </span>
              <div className="relative h-7 bg-paper-soft/60 rounded-sm overflow-hidden">
                <div
                  className="h-full rounded-sm"
                  style={{
                    width: `${Math.max(w * 100, 0.6)}%`,
                    background: r.color,
                    opacity: 0.85,
                  }}
                />
              </div>
              <span className="font-mono tabular text-[12px] text-ink-soft tabular-nums whitespace-nowrap">
                {fmtUnit(r.value, benchmark.unit)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] font-mono uppercase tracking-[0.12em] text-ink-faint">
        {useLog ? "Log scale · " : ""}p50 · last 24 h
      </p>
    </figure>
  );
}
