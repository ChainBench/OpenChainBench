"use client";

import type { Benchmark } from "@/types/benchmark";
import { ProviderLogo } from "@/components/provider-logo";
import { fmtUnit } from "@/lib/format";
import { buildProviderColors } from "@/lib/series-colors";

/**
 * Per-provider distribution view. One row per provider, three horizontal
 * marks at p50 / p90 / p99 along a shared field-wide scale. Reads as
 * "where does each provider sit on the latency spectrum and how wide
 * is its tail." Complements the time-series view (drift) and the ranked-bar
 * view (rank order) by surfacing tail behaviour at a glance.
 *
 * Skips unavailable rows and rows with p50 == 0 so the field scale isn't
 * collapsed to a single column by missing-data placeholders.
 */
export function DistributionChart({ benchmark }: { benchmark: Benchmark }) {
  const { results, unit, higherIsBetter } = benchmark;

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

  // Shared scale across providers so the bars are directly comparable.
  // Anchor at 0 and the max of p99 across the field; one outlier widens
  // everyone, which is the point (you want to see who's tail-heavy).
  const fieldMax = Math.max(...live.map((r) => r.ms.p99));
  const scale = (v: number) => Math.max(0, Math.min(100, (v / fieldMax) * 100));

  const colors = buildProviderColors(results);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <p className="label-mono text-ink-faint">
          Latency distribution · p50 / p90 / p99
        </p>
        <p className="label-mono text-ink-faint hidden sm:block">
          0 → {fmtUnit(fieldMax, unit)}
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-rule">
        {sorted.map((r) => {
          const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
          const p50Pct = scale(r.ms.p50);
          const p90Pct = scale(r.ms.p90);
          const p99Pct = scale(r.ms.p99);
          return (
            <li key={r.slug} className="py-3">
              <div className="flex items-center gap-2 mb-2 min-w-0">
                <ProviderLogo slug={r.slug} name={r.name} size={18} />
                <span
                  className="font-serif font-semibold truncate text-[13px]"
                  style={{ color }}
                >
                  {r.name}
                </span>
                <span className="ml-auto label-mono text-ink-faint tabular shrink-0">
                  {fmtUnit(r.ms.p50, unit)}
                </span>
              </div>
              {/* Track */}
              <div className="relative h-4 rounded-sm bg-paper-soft">
                {/* p50 → p99 spread band */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full"
                  style={{
                    left: `${Math.min(p50Pct, p99Pct)}%`,
                    width: `${Math.abs(p99Pct - p50Pct)}%`,
                    background: `${color}40`,
                  }}
                  aria-hidden
                />
                {/* p50 marker */}
                <Marker pct={p50Pct} color={color} label="p50" tip={fmtUnit(r.ms.p50, unit)} />
                {/* p90 marker */}
                <Marker pct={p90Pct} color={color} label="p90" tip={fmtUnit(r.ms.p90, unit)} dimmed />
                {/* p99 marker */}
                <Marker pct={p99Pct} color={color} label="p99" tip={fmtUnit(r.ms.p99, unit)} dimmed />
              </div>
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
