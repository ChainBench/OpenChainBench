"use client";

import { useState } from "react";
import type { Benchmark } from "@/types/benchmark";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import { methodologyTooltip } from "@/lib/methodology-tooltip";
import { buildProviderColors } from "@/lib/series-colors";

/**
 * Per-provider distribution view. One row per provider, three horizontal
 * marks at p50 / p90 / p99 along a shared field-wide scale. Reads as
 * "where does each provider sit on the latency spectrum and how wide
 * is its tail." Complements the time-series view (drift) and the ranked-bar
 * view (rank order) by surfacing tail behaviour at a glance.
 *
 * Skips unavailable rows and rows with p50 == 0 so the field scale isn't
 * collapsed to a single column by missing-data placeholders. Excluded
 * rows are dimmed but still rendered so the reader sees what they hid.
 */
export function DistributionChart({
  benchmark,
  excluded: controlledExcluded,
  onToggleExclude,
}: {
  benchmark: Benchmark;
  /** Shared exclusion set with the rest of the bench's chart views.
   *  When omitted the chart manages its own local state. */
  excluded?: Set<string>;
  onToggleExclude?: (slug: string) => void;
}) {
  const { results, unit, higherIsBetter } = benchmark;
  const [internalExcluded, setInternalExcluded] = useState<Set<string>>(
    () => new Set(),
  );
  const excluded = controlledExcluded ?? internalExcluded;
  const toggle = (slug: string) => {
    if (onToggleExclude) {
      onToggleExclude(slug);
      return;
    }
    setInternalExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const live = results.filter(
    (r) => r.availability !== "unavailable" && r.ms.p50 > 0,
  );
  if (live.length === 0) {
    return (
      <p className="label-mono text-ink-faint py-8 text-center">
        No live samples in this view yet.
      </p>
    );
  }

  const sorted = [...live].sort((a, b) =>
    higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );

  // Field scale recomputes from visible rows only - excluding an outlier
  // lets the remaining providers fill the track.
  const visible = sorted.filter((r) => !excluded.has(r.slug));
  const fieldMax = Math.max(...visible.map((r) => r.ms.p99), 1);
  const scale = (v: number) => Math.max(0, Math.min(100, (v / fieldMax) * 100));

  const colors = buildProviderColors(results);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <p className="label-mono text-ink-faint">
          Latency distribution · p50 / p90 / p99 · click rows to exclude
        </p>
        <p className="label-mono text-ink-faint hidden sm:block">
          0 → {fmtUnit(fieldMax, unit)}
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-rule">
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
              title={methodologyTooltip(r, isOff)}
              className={`grid grid-cols-[minmax(6rem,9rem)_1fr_auto] sm:grid-cols-[minmax(8rem,12rem)_1fr_auto] items-center gap-3 sm:gap-4 py-2.5 cursor-pointer rounded-sm transition-colors hover:bg-paper-soft/40 ${
                isOff ? "opacity-40" : ""
              }`}
            >
              {/* Identity column — logo + name on one line, no white gap above the track */}
              <span className="flex items-center gap-2 min-w-0 text-[13px]">
                <ProviderLogo slug={r.slug} name={r.name} size={18} />
                <span
                  className={`font-serif font-semibold truncate ${
                    isOff ? "line-through decoration-1" : ""
                  }`}
                  style={{ color: isOff ? "var(--color-ink-faint)" : color }}
                >
                  {r.name}
                </span>
              </span>
              {/* Track column — inline with the name so the row reads in a single line */}
              <div className="relative h-4 rounded-sm bg-paper-soft">
                {!isOff && (
                  <>
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full"
                      style={{
                        left: `${Math.min(p50Pct, p99Pct)}%`,
                        width: `${Math.abs(p99Pct - p50Pct)}%`,
                        background: `${color}40`,
                      }}
                      aria-hidden
                    />
                    <Marker pct={p50Pct} color={color} label="p50" tip={fmtUnit(r.ms.p50, unit)} />
                    <Marker pct={p90Pct} color={color} label="p90" tip={fmtUnit(r.ms.p90, unit)} dimmed />
                    <Marker pct={p99Pct} color={color} label="p99" tip={fmtUnit(r.ms.p99, unit)} dimmed />
                  </>
                )}
              </div>
              <span className="label-mono text-ink-faint tabular shrink-0 whitespace-nowrap">
                {fmtUnit(r.ms.p50, unit)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Marker({
  pct,
  color,
  label,
  tip,
  dimmed,
}: {
  pct: number;
  color: string;
  label: string;
  tip: string;
  dimmed?: boolean;
}) {
  return (
    <span
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[3px] h-3 rounded-sm"
      style={{
        left: `${pct}%`,
        background: color,
        opacity: dimmed ? 0.55 : 1,
      }}
      title={`${label}: ${tip}`}
      aria-label={`${label} ${tip}`}
    />
  );
}
