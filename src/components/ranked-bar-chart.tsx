"use client";

import { useMemo, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { LiveDot } from "@/components/live-dot";
import { ProviderLogo } from "@/components/provider-logo";

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
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());

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

  // The bar scale recomputes from visible rows only — excluding the
  // tail outliers gives the remaining bars more room to breathe.
  const visibleValues = rows
    .filter((r) => !excluded.has(r.slug))
    .map((r) => r.value);
  const maxV = Math.max(...visibleValues, 1);
  const minV = Math.min(...visibleValues.filter((v) => v > 0), maxV);

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

  function toggle(slug: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  const excludedCount = excluded.size;
  // Visible-row ranking — excluded rows lose their #N badge so the
  // remaining list reads as a clean leaderboard.
  let visibleRank = 0;

  return (
    <figure className="my-2">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          <LiveDot />
          <span>{benchmark.metric} · last 24 hours</span>
        </p>
        {excludedCount > 0 && (
          <button
            type="button"
            onClick={() => setExcluded(new Set())}
            className="text-[10px] font-sans font-medium uppercase tracking-[0.16em] text-ink-muted hover:text-ink lnk"
          >
            Reset · {excludedCount} excluded
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {rows.map((r) => {
          const isOff = excluded.has(r.slug);
          const w = isOff ? 0 : project(r.value);
          const hasNote = r.methodNotes.length > 0;
          if (!isOff) visibleRank += 1;
          const rank = isOff ? null : visibleRank;
          return (
            <li
              key={r.slug}
              onClick={() => toggle(r.slug)}
              role="button"
              tabIndex={0}
              aria-pressed={isOff}
              title={
                isOff
                  ? `Click to include ${r.name} in the chart`
                  : `Click to exclude ${r.name} from the chart`
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(r.slug);
                }
              }}
              className={`group relative grid grid-cols-[2rem_minmax(5rem,8rem)_1fr_auto] sm:grid-cols-[2.5rem_minmax(7rem,11rem)_1fr_auto] items-center gap-3 sm:gap-4 cursor-pointer rounded-sm transition-colors hover:bg-paper-soft/40 ${
                isOff ? "opacity-40" : ""
              }`}
            >
              <span className="font-sans tabular text-[11px] text-ink-faint text-right">
                {rank !== null ? `#${rank}` : "-"}
              </span>
              <span
                className={`inline-flex items-center gap-2 text-[13px] truncate ${
                  isOff ? "text-ink-faint line-through decoration-1" : "text-ink"
                }`}
                title={r.tag}
              >
                <ProviderLogo slug={r.slug} name={r.name} size={18} />
                <span className="truncate">{r.name}</span>
              </span>
              <div className="relative h-7 bg-paper-soft/60 rounded-sm overflow-hidden">
                <div
                  className="h-full rounded-sm transition-[width,opacity] duration-300"
                  style={{
                    width: `${Math.max(w * 100, isOff ? 0 : 0.6)}%`,
                    background: r.color,
                    opacity: isOff ? 0 : 0.85,
                  }}
                />
              </div>
              <span
                className={`font-sans tabular text-[12px] tabular-nums whitespace-nowrap ${
                  isOff ? "text-ink-faint" : "text-ink-soft"
                }`}
              >
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
      <p className="mt-3 text-[11px] font-sans font-medium uppercase tracking-[0.12em] text-ink-faint">
        {useLog ? "Log scale · " : ""}p50 · last 24 h · click rows to exclude
      </p>
    </figure>
  );
}
