"use client";

import { type ReactNode, useMemo } from "react";
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
  const max = Math.max(...ranked.map((r) => r.ms.p50)) || 1;
  const colors = useMemo(() => buildProviderColors(benchmark.results), [benchmark.results]);

  const leader = ranked[0];
  const trailer = ranked[ranked.length - 1];
  const gap = leader && trailer && trailer.ms.p50 > 0
    ? leader.ms.p50 / trailer.ms.p50
    : 0;

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
          {headerActions}
        </div>
      )}
      {/* Thin summary strip. matches the latency-bench layout. */}
      <dl className="grid grid-cols-2 sm:flex sm:flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-rule py-4">
        <CountStat
          label="Leader"
          value={fmtValue(leader?.ms.p50 ?? 0, benchmark.unit)}
          hint={leader?.name}
        />
        <CountStat
          label="Range"
          value={`${fmtValue(trailer?.ms.p50 ?? 0, benchmark.unit)} → ${fmtValue(leader?.ms.p50 ?? 0, benchmark.unit)}`}
          hint={`${benchmark.results.length} providers`}
        />
        <CountStat
          label="Gap"
          value={gap > 0 ? `${gap.toFixed(1)}×` : "-"}
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
            const pct = (r.ms.p50 / max) * 100;
            const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
            return (
              <li key={r.slug}>
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
    <div className="flex items-baseline gap-2">
      <dt className="font-sans text-[10px] uppercase tracking-[0.18em] text-ink-faint shrink-0 font-medium">
        {label}
      </dt>
      <dd className="font-sans tabular text-sm text-ink leading-none">
        {value}
        {hint ? (
          <span className="ml-1.5 text-ink-muted text-xs font-normal">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}
