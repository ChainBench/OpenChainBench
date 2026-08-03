"use client";

import { type ReactNode, useMemo, useState } from "react";
import Link from "next/link";

import type { Benchmark } from "@/types/benchmark";
import { fmtValue } from "@/lib/format";
import { rankResults } from "@/lib/ranking";
import { buildProviderColors } from "@/lib/series-colors";
import { ProviderLogo } from "@/components/provider-logo";

/**
 * Dedicated view for `count` / coverage benches where p50/p90/p99 are
 * meaningless (the value is a single gauge) and a 24-hour latency chart
 * collapses to a flat line. Renders a podium + a horizontal comparison
 * bar instead. the two visualizations that actually carry information
 * for this metric shape.
 */
export function CountLeaderboard({
  benchmark,
  headerActions,
}: {
  benchmark: Benchmark;
  headerActions?: ReactNode;
}) {
  const ranked = rankResults(benchmark.results, benchmark.higherIsBetter);
  // Exclude +Inf from max so finite bars render at meaningful widths
  // instead of collapsing to 0% (Inf/Inf = NaN).
  const finiteVals = ranked.map((r) => r.ms.p50).filter(Number.isFinite);
  const max = Math.max(...finiteVals) || 1;
  const colors = useMemo(() => buildProviderColors(benchmark.results), [benchmark.results]);
  const [hoveredSlug, setHoveredSlug] = useState<string | null>(null);

  const validRanked = ranked.filter((r) => r.ms.p50 > 0);
  const leader = validRanked[0];
  const trailer = validRanked[validRanked.length - 1];
  const rawGap =
    leader && trailer && leader.ms.p50 > 0
      ? benchmark.higherIsBetter
        ? leader.ms.p50 / trailer.ms.p50
        : trailer.ms.p50 / leader.ms.p50
      : 0;
  const gapRatio = Number.isFinite(rawGap) ? rawGap : null;
  // range: always ascending (best → worst). for lower-is-better leader is min,
  // trailer is max; for higher-is-better flip them so low is still left.
  const [rangeMin, rangeMax] = benchmark.higherIsBetter
    ? [trailer, leader]
    : [leader, trailer];

  return (
    <>
      {/* Header row: leaderboard label + headerActions slot (view
          switcher). Aligned with the same baseline pattern as the
          other chart views so the toolbar position is consistent
          across views. */}
      {headerActions && (
        <div className="flex items-center justify-between gap-3 mb-3 min-h-7">
          <p className="text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-faint">
            Leaderboard
          </p>
          <div className="flex items-center gap-2">{headerActions}</div>
        </div>
      )}
      {/* Thin summary strip. matches the latency-bench layout. */}
      <dl className="grid grid-cols-1 sm:flex sm:flex-wrap items-baseline gap-x-3 sm:gap-x-8 gap-y-2 sm:gap-y-3 border-y border-rule py-4">
        <CountStat
          label="Leader"
          value={leader ? fmtValue(leader.ms.p50, benchmark.unit) : "-"}
          hint={leader?.name}
        />
        <CountStat
          label="Range"
          value={
            rangeMin && rangeMax
              ? `${fmtValue(rangeMin.ms.p50, benchmark.unit)} → ${fmtValue(rangeMax.ms.p50, benchmark.unit)}`
              : "-"
          }
          hint={`${validRanked.length} providers`}
        />
        <CountStat
          label="Gap"
          value={gapRatio != null && gapRatio > 0 ? `${gapRatio.toFixed(1)}×` : "-"}
          hint="leader vs lowest"
        />
      </dl>

      {/* Horizontal bars. the comparison that actually reads */}
      <div className="mt-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          {benchmark.metric} · by product
        </p>
        <ol className="mt-4 space-y-3">
          {ranked.map((r, i) => {
            // +Inf venues get full-width bar (visually "worst"); finite bar otherwise.
            const pct = Number.isFinite(r.ms.p50) ? (r.ms.p50 / max) * 100 : 100;
            const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
            const hasFormula = Boolean(r.formula);
            const isHovered = hoveredSlug === r.slug;
            return (
              <li
                key={r.slug}
                className={`relative ${isHovered ? "z-40" : ""}`}
                onMouseEnter={() => setHoveredSlug(r.slug)}
                onMouseLeave={() => setHoveredSlug(null)}
              >
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-sans tabular text-[11px] text-ink-faint w-5 shrink-0">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <ProviderLogo slug={r.slug} name={r.name} size={18} />
                    <Link
                      href={`/products/${r.slug}`}
                      className="font-medium text-ink truncate hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.tag ? (
                      <span className="text-xs text-ink-muted hidden sm:inline truncate">
                        {r.tag}
                      </span>
                    ) : null}
                  </div>
                  <span className="font-sans tabular text-base text-ink shrink-0">
                    {fmtValue(r.ms.p50, benchmark.unit)}
                  </span>
                </div>
                <div className="h-2 bg-rule/40 overflow-hidden rounded-sm">
                  <div
                    className="h-full"
                    style={{
                      width: `${pct}%`,
                      background: color,
                      transition: "width 0.6s ease",
                    }}
                  />
                </div>
                {hasFormula && isHovered && (
                  <div
                    role="tooltip"
                    className="pointer-events-none absolute left-8 top-full z-50 mt-1 w-[min(28rem,90vw)] rounded-md border border-rule bg-paper px-3 py-2 shadow-xl"
                  >
                    <p className="text-xs leading-snug text-ink-soft">
                      <span className="font-medium" style={{ color }}>
                        {r.name}:
                      </span>{" "}
                      {r.formula}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

function CountStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <dt className="font-sans text-[10px] uppercase tracking-[0.14em] sm:tracking-[0.18em] text-ink-faint shrink-0 font-medium">
        {label}
      </dt>
      <dd className="font-sans tabular text-sm text-ink leading-none min-w-0 truncate">
        {value}
        {hint ? (
          <span className="ml-1.5 text-ink-muted text-xs font-normal">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}
