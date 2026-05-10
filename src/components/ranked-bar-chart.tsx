"use client";

import { useMemo } from "react";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { LiveDot } from "@/components/live-dot";

type Props = { benchmark: Benchmark };

/**
 * Try to match a provider's name against the bench's methodology bullets.
 * Useful for benches like l1-finality where each chain has its own
 * harness method ("Ethereum: eth_getBlockByNumber…", "Solana: getSlot…").
 * Falls back to an empty list when no per-provider line is found.
 */
function matchMethodFor(name: string, methodology: string[]): string[] {
  const tokens = name
    .replace(/\s+(Smart Chain|C-Chain|v\d+|\.trade)/gi, "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  return methodology.filter((m) => {
    const lower = m.toLowerCase();
    return tokens.some((t) => lower.includes(t));
  });
}

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
      methodNotes: matchMethodFor(r.name, benchmark.methodology),
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
      <p className="mb-3 inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
        <LiveDot />
        <span>{benchmark.metric} · last 24 hours</span>
      </p>
      <ul className="space-y-2">
        {rows.map((r, idx) => {
          const w = project(r.value);
          const hasNote = r.methodNotes.length > 0;
          return (
            <li
              key={r.slug}
              className="group relative grid grid-cols-[2.5rem_minmax(7rem,11rem)_1fr_auto] items-center gap-3 sm:gap-4"
            >
              <span className="font-mono tabular text-[11px] text-ink-faint text-right">
                #{idx + 1}
              </span>
              <span className="text-[13px] text-ink truncate" title={r.tag}>
                {r.name}
              </span>
              <div className="relative h-7 bg-paper-soft/60 rounded-sm overflow-hidden">
                <div
                  className="h-full rounded-sm transition-opacity"
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
              {hasNote && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute left-[calc(2.5rem+0.75rem)] top-full z-30 mt-1 hidden w-[min(28rem,90vw)] rounded-md border border-rule bg-paper p-3 shadow-xl group-hover:block"
                >
                  <p
                    className="text-[10px] font-medium uppercase tracking-[0.16em] mb-2"
                    style={{ color: r.color }}
                  >
                    How {r.name} is measured
                  </p>
                  <ul className="space-y-1.5 text-xs leading-relaxed text-ink-soft">
                    {r.methodNotes.map((m) => (
                      <li key={m} className="flex gap-2">
                        <span className="text-ink-faint mt-1">·</span>
                        <span>{m}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
