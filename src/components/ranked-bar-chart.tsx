"use client";

import { useMemo, useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { useChartExclusion } from "@/hooks/use-chart-exclusion";
import { LiveDot } from "@/components/live-dot";
import { ProviderLogo } from "@/components/provider-logo";

type Props = {
  benchmark: Benchmark;
  /** Optional controlled exclusion set. When provided, this chart
   *  defers exclusion state to the parent so multiple views (ranked
   *  bar, distribution, donut, timeseries) can share which providers
   *  the reader has hidden. */
  excluded?: Set<string>;
  onToggleExclude?: (slug: string) => void;
  onResetExcluded?: () => void;
  /** Optional slot rendered in the chart's header row, right-aligned.
   *  BenchmarkBody passes the <ViewSwitcher> here. */
  headerActions?: import("react").ReactNode;
};

export function RankedBarChart({
  benchmark,
  excluded: controlledExcluded,
  onToggleExclude,
  onResetExcluded,
  headerActions,
}: Props) {
  const { excluded, toggle, reset } = useChartExclusion(
    controlledExcluded,
    onToggleExclude,
    onResetExcluded,
  );

  const [hoveredSlug, setHoveredSlug] = useState<string | null>(null);

  const colors = useMemo(
    () => buildProviderColors(benchmark.results),
    [benchmark.results]
  );

  // Unscored providers (availability=unavailable AND no p50) are dropped
  // up front: they're SEO-relevant for /products page coverage but they
  // are pure visual noise on a "ranked by performance" view. The
  // ledger below mirrors the same filter so the two surfaces tell the
  // same story.
  const allRows = useMemo(() => {
    const scored = benchmark.results.filter(
      (r) => r.availability !== "unavailable" || r.ms.p50 > 0
    );
    const sorted = scored.sort((a, b) =>
      benchmark.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50
    );
    return sorted.map((r) => ({
      slug: r.slug,
      name: r.name,
      tag: r.tag,
      value: r.ms.p50,
      color: colors.get(r.slug) ?? "var(--color-ink-soft)",
      formula: r.formula,
      query: r.query,
    }));
  }, [benchmark, colors]);

  // Top-N selector — sized off the registered cohort, mirroring the
  // time-series chart. When the bench ships more than 10 providers the
  // toolbar exposes Top 5 / 10 / 20 / All so a cluttered leaderboard
  // can be focused without losing the option to widen.
  const cohortSize = benchmark.results.length;
  const TOP_N_DEFAULT = cohortSize > 20 ? 20 : null;
  const [topN, setTopN] = useState<number | null>(TOP_N_DEFAULT);
  const rows = useMemo(() => {
    if (topN == null) return allRows;
    return allRows.slice(0, topN);
  }, [allRows, topN]);

  // The bar scale recomputes from visible rows only - excluding the
  // tail outliers gives the remaining bars more room to breathe.
  const visibleValues = rows
    .filter((r) => !excluded.has(r.slug))
    .map((r) => r.value);
  const maxV = Math.max(...visibleValues, 1);
  const minV = Math.min(...visibleValues.filter((v) => v > 0), maxV);

  // Use log scale when dynamic range > 50x - typical for finality where
  // sub-second chains coexist with 30-min ones. Linear scale crushes
  // everything below the slowest chain into invisible slivers. Min-clamp
  // is a tiny epsilon (not 1) so sub-1 ranges — typical for second-scale
  // latency benches — get detected as wide-dynamic-range correctly and
  // sub-1 values don't all collapse to 0 width on the log axis.
  const EPS = 1e-6;
  const useLog = maxV / Math.max(minV, EPS) > 50;

  const project = (v: number) => {
    if (!useLog) return Math.max(0, v) / maxV;
    if (v <= 0) return 0;
    const lo = Math.log10(Math.max(minV / 2, EPS));
    const hi = Math.log10(maxV);
    return Math.max(0, (Math.log10(v) - lo) / (hi - lo));
  };

  const excludedCount = excluded.size;
  // Visible-row ranking - excluded rows lose their #N badge so the
  // remaining list reads as a clean leaderboard.
  let visibleRank = 0;

  return (
    <figure className="my-2">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 min-h-7">
        <p className="inline-flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          <LiveDot />
          <span>{benchmark.metric} · last 24 hours</span>
        </p>
        <div className="flex items-center gap-3">
          {excludedCount > 0 && (
            <button
              type="button"
              onClick={reset}
              className="text-[10px] font-sans font-medium uppercase tracking-[0.16em] text-ink-muted hover:text-ink lnk"
            >
              Reset · {excludedCount} excluded
            </button>
          )}
          {headerActions}
        </div>
      </div>
      {cohortSize > 10 && (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-1">
          <span className="mr-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            Show
          </span>
          {([5, 10, 20, null] as const).map((n) => {
            const active = topN === n;
            const label = n == null ? "All" : `Top ${n}`;
            return (
              <button
                key={String(n)}
                type="button"
                onClick={() => setTopN(n)}
                className={`rounded-md border px-2 py-1 text-[11px] font-sans font-medium uppercase tracking-[0.1em] transition-all ${
                  active
                    ? "border-ink bg-ink text-paper"
                    : "border-ink/15 bg-paper text-ink hover:border-ink/40"
                }`}
                aria-pressed={active}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <ul className="space-y-2">
        {rows.map((r) => {
          const isOff = excluded.has(r.slug);
          const w = isOff ? 0 : project(r.value);
          const hasFormula = Boolean(r.formula);
          const isHovered = hoveredSlug === r.slug;
          if (!isOff) visibleRank += 1;
          const rank = isOff ? null : visibleRank;
          return (
            <li
              key={r.slug}
              onClick={() => toggle(r.slug)}
              onMouseEnter={() => setHoveredSlug(r.slug)}
              onMouseLeave={() => setHoveredSlug(null)}
              onFocus={() => setHoveredSlug(r.slug)}
              onBlur={() => setHoveredSlug(null)}
              role="button"
              tabIndex={0}
              aria-pressed={isOff}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(r.slug);
                }
              }}
              className={`relative grid grid-cols-[2rem_minmax(5rem,8rem)_1fr_auto] sm:grid-cols-[2.5rem_minmax(7rem,11rem)_1fr_auto] items-center gap-3 sm:gap-4 cursor-pointer rounded-sm transition-colors hover:bg-paper-soft/40 ${
                isHovered ? "z-40" : ""
              } ${isOff ? "opacity-40" : ""}`}
            >
              <span className="font-sans tabular text-[11px] text-ink-faint text-right">
                {rank !== null ? `#${rank}` : "-"}
              </span>
              <span
                className={`inline-flex items-center gap-2 text-[13px] truncate ${
                  isOff ? "text-ink-faint line-through decoration-1" : "text-ink"
                }`}
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
              {hasFormula && isHovered && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute left-[calc(2.5rem+0.75rem)] top-full z-50 mt-1 w-[min(28rem,90vw)] rounded-md border border-rule bg-paper px-3 py-2 shadow-xl"
                >
                  <p className="text-xs leading-snug text-ink-soft">
                    <span
                      className="font-medium"
                      style={{ color: r.color }}
                    >
                      {r.name}:
                    </span>{" "}
                    {r.formula}
                  </p>
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
