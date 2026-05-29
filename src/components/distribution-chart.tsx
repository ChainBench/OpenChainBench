"use client";

import { type ReactNode, useMemo } from "react";
import type { Benchmark } from "@/types/benchmark";
import { liveResults } from "@/lib/provider-filters";
import { Hint } from "@/components/hint";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";
import { useChartExclusion } from "@/hooks/use-chart-exclusion";

/**
 * Latency-spread view. One row per provider, three markers (p50 / p90 /
 * p99) plotted on a shared field-wide scale.
 *
 * Design borrowed from Vercel Speed Insights / Honeycomb service list:
 *   - Sans-serif provider name (serif read amateur on data dense rows).
 *   - 4-column row: name | track | p50 | p99 — two values right-aligned,
 *     not one, so the spread story is in the table itself, not just the
 *     visual.
 *   - Thin 2 px hairline track that spans the row; per-row coloured
 *     band between p50 and p99 at low opacity sits on top.
 *   - Three differentiated markers: filled dot (p50), outlined dot (p90),
 *     vertical bar (p99). Reader learns the grammar from the small
 *     header legend.
 */
export function DistributionChart({
  benchmark,
  excluded: controlledExcluded,
  onToggleExclude,
  headerActions,
}: {
  benchmark: Benchmark;
  excluded?: Set<string>;
  onToggleExclude?: (slug: string) => void;
  /** Optional slot rendered in the chart's header row, right-aligned.
   *  BenchmarkBody passes the <ViewSwitcher> here so the control sits
   *  on the same baseline as the chart title instead of floating in
   *  the card corner or eating a footer row of its own. */
  headerActions?: ReactNode;
}) {
  const { results, unit, higherIsBetter } = benchmark;
  const { excluded, toggle } = useChartExclusion(
    controlledExcluded,
    onToggleExclude,
  );

  const colors = useMemo(() => buildProviderColors(results), [results]);

  const live = liveResults(results);
  if (live.length === 0) {
    return <p className="text-[12px] text-ink-faint py-8 text-center">No data.</p>;
  }

  const sorted = [...live].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );

  // Field scale recomputes from visible rows only - excluding an outlier
  // gives the remaining rows the full track width. We take both extremes
  // because the auto-log switch needs the dynamic range, not just the max.
  const visible = sorted.filter((r) => !excluded.has(r.slug));
  const fieldMax = Math.max(...visible.map((r) => r.ms.p99), 1);
  const fieldMin = Math.min(
    ...visible.flatMap((r) => [r.ms.p50, r.ms.p90, r.ms.p99]).filter((v) => v > 0),
    fieldMax,
  );

  // Use log scale when dynamic range > 50x. Same threshold as
  // ranked-bar-chart for consistency. Critical on benches like l1-finality
  // where TON (0.4 s) coexists with Monero (36 min): a linear scale
  // collapses every sub-second chain into the same invisible pixel at the
  // left, making 8 of 9 rows visually indistinguishable.
  const useLog = fieldMax / Math.max(fieldMin, 1) > 50;

  // Both paths anchor the left edge at fieldMin (best observed value),
  // not at absolute zero. Otherwise narrow-range benches with small mins
  // (e.g. solana-tx-landing-latency where every provider's p50 = 2 slots
  // on a 14-slot field) compress every median dot into a single sliver
  // at the left, making it impossible to read dispersion. With this
  // baseline the leader sits at 0 % and laggards spread the full track.
  const scale = (v: number) => {
    if (v <= 0) return 0;
    if (useLog) {
      const lo = Math.log10(Math.max(1, fieldMin / 2));
      const hi = Math.log10(fieldMax);
      if (hi <= lo) return 50;
      return Math.max(0, Math.min(100, ((Math.log10(v) - lo) / (hi - lo)) * 100));
    }
    const range = fieldMax - fieldMin;
    if (range <= 0) return 50;
    return Math.max(0, Math.min(100, ((v - fieldMin) / range) * 100));
  };

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3 mb-5 min-h-7">
        <p className="text-[11px] font-sans font-medium uppercase tracking-[0.18em] text-ink-faint">
          Latency spread
        </p>
        <div className="flex items-center gap-3">
          <MarkerLegend />
          {headerActions}
        </div>
      </div>
      <ul className="flex flex-col">
        {sorted.map((r) => {
          const isOff = excluded.has(r.slug);
          const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
          const p50Pct = isOff ? 0 : scale(r.ms.p50);
          const p90Pct = isOff ? 0 : scale(r.ms.p90);
          const p99Pct = isOff ? 0 : scale(r.ms.p99);
          return (
            <li
              key={r.slug}
              role="button"
              tabIndex={0}
              aria-pressed={isOff}
              onClick={() => toggle(r.slug)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(r.slug);
                }
              }}
              className={`grid grid-cols-[minmax(6rem,9rem)_1fr_3rem_3rem] sm:grid-cols-[minmax(7rem,10rem)_1fr_3.5rem_3.5rem] items-center gap-3 sm:gap-4 py-3 border-b border-rule/50 last:border-b-0 cursor-pointer transition-colors hover:bg-paper-soft/40 ${
                isOff ? "opacity-40" : ""
              }`}
            >
              {/* Identity column right-aligned: pushes the logo+name flush
                  against the track start so the eye reads
                  name → track without a white gap to cross. Empty space
                  (when name is short like 'BNB') stays on the LEFT
                  edge of the row where it's off the visual path. */}
              <span className="flex items-center gap-2 min-w-0 justify-end">
                <ProviderLogo slug={r.slug} name={r.name} size={18} />
                <span
                  className={`font-sans font-medium text-[12.5px] truncate ${
                    isOff ? "line-through decoration-1 text-ink-faint" : "text-ink"
                  }`}
                >
                  {r.name}
                </span>
              </span>
              {/* Track. 1 px reference hairline + per-row coloured band
                  + three differentiated markers. */}
              <div className="relative h-5">
                {/* Reference hairline spanning the field. */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-px bg-rule"
                  aria-hidden
                />
                {/* Median guide at 50 % of the field. */}
                <div
                  className="absolute top-1 bottom-1 w-px bg-rule"
                  style={{ left: "50%" }}
                  aria-hidden
                />
                {!isOff && (
                  <>
                    {/* p50 → p99 spread band */}
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full"
                      style={{
                        left: `${Math.min(p50Pct, p99Pct)}%`,
                        width: `${Math.abs(p99Pct - p50Pct)}%`,
                        background: color,
                        opacity: 0.18,
                      }}
                      aria-hidden
                    />
                    {/* p99 — vertical bar, right edge of the spread */}
                    <Hint label={`p99 ${fmtUnit(r.ms.p99, unit)}`}>
                      <span
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-0.5 h-3.5 rounded-sm"
                        style={{ left: `${p99Pct}%`, background: color }}
                        aria-label={`p99 ${fmtUnit(r.ms.p99, unit)}`}
                      />
                    </Hint>
                    {/* p90 — outlined ring */}
                    <Hint label={`p90 ${fmtUnit(r.ms.p90, unit)}`}>
                      <span
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full"
                        style={{
                          left: `${p90Pct}%`,
                          border: `1.5px solid ${color}`,
                          background: "var(--color-paper)",
                        }}
                        aria-label={`p90 ${fmtUnit(r.ms.p90, unit)}`}
                      />
                    </Hint>
                    {/* p50 — filled dot, the headline */}
                    <Hint label={`p50 ${fmtUnit(r.ms.p50, unit)}`}>
                      <span
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full"
                        style={{ background: color }}
                        aria-label={`p50 ${fmtUnit(r.ms.p50, unit)}`}
                      />
                    </Hint>
                  </>
                )}
              </div>
              <span className="font-mono tabular text-[11.5px] text-ink-soft text-right tabular-nums">
                {fmtUnit(r.ms.p50, unit)}
              </span>
              <span className="font-mono tabular text-[11.5px] text-ink-faint text-right tabular-nums">
                {fmtUnit(r.ms.p99, unit)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center justify-between text-[10px] font-sans uppercase tracking-[0.14em] text-ink-faint">
        <span>min {fmtUnit(fieldMin, unit)}</span>
        <span>
          {useLog ? "log scale · " : ""}max {fmtUnit(fieldMax, unit)}
        </span>
      </div>
    </div>
  );
}

function MarkerLegend() {
  return (
    <div className="hidden sm:flex items-center gap-3 text-[10px] font-sans uppercase tracking-[0.14em] text-ink-faint">
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full"
          style={{ background: "var(--color-ink-muted)" }}
          aria-hidden
        />
        p50
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ border: "1.5px solid var(--color-ink-muted)" }}
          aria-hidden
        />
        p90
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block w-0.5 h-3 rounded-sm"
          style={{ background: "var(--color-ink-muted)" }}
          aria-hidden
        />
        p99
      </span>
    </div>
  );
}
