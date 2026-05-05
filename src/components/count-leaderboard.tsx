import type { Benchmark } from "@/types/benchmark";
import { fmtValue } from "@/lib/format";
import { rankResults } from "@/lib/ranking";
import { buildProviderColors } from "@/lib/series-colors";

/**
 * Dedicated view for `count` / coverage benches where p50/p90/p99 are
 * meaningless (the value is a single gauge) and a 24-hour latency chart
 * collapses to a flat line. Renders a podium + a horizontal comparison
 * bar instead — the two visualizations that actually carry information
 * for this metric shape.
 */
export function CountLeaderboard({ benchmark }: { benchmark: Benchmark }) {
  const ranked = rankResults(benchmark.results, benchmark.higherIsBetter);
  const max = Math.max(...ranked.map((r) => r.ms.p50)) || 1;
  const colors = buildProviderColors(benchmark.results);

  const leader = ranked[0];
  const trailer = ranked[ranked.length - 1];
  const gap = leader && trailer && trailer.ms.p50 > 0
    ? leader.ms.p50 / trailer.ms.p50
    : 0;

  return (
    <>
      {/* Hero summary row — leader + spread, nothing fancy */}
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-px bg-rule rounded overflow-hidden border border-rule">
        <div className="bg-surface px-5 py-5">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
            Leader
          </p>
          <p className="mt-1 display text-3xl tabular leading-none">
            {fmtValue(leader?.ms.p50 ?? 0, benchmark.unit)}
          </p>
          <p className="mt-1 text-xs text-ink-muted">{leader?.name ?? "—"}</p>
        </div>
        <div className="bg-surface px-5 py-5">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
            Field range
          </p>
          <p className="mt-1 display text-3xl tabular leading-none">
            {fmtValue(trailer?.ms.p50 ?? 0, benchmark.unit)}
            <span className="text-ink-faint"> → </span>
            {fmtValue(leader?.ms.p50 ?? 0, benchmark.unit)}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {benchmark.results.length} providers
          </p>
        </div>
        <div className="bg-surface px-5 py-5">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
            Gap
          </p>
          <p className="mt-1 display text-3xl tabular leading-none">
            {gap > 0 ? `${gap.toFixed(1)}×` : "—"}
          </p>
          <p className="mt-1 text-xs text-ink-muted">leader vs lowest</p>
        </div>
      </div>

      {/* Horizontal bars — the comparison that actually reads */}
      <div className="mt-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
          {benchmark.metric} · by provider
        </p>
        <ol className="mt-4 space-y-3">
          {ranked.map((r, i) => {
            const pct = (r.ms.p50 / max) * 100;
            const color = colors.get(r.slug) ?? "var(--color-ink-soft)";
            return (
              <li key={r.slug}>
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <div className="flex items-baseline gap-3 min-w-0">
                    <span className="font-mono text-[11px] tabular text-ink-faint w-5 shrink-0">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="font-medium text-ink truncate">{r.name}</span>
                    {r.tag ? (
                      <span className="text-xs text-ink-muted hidden sm:inline truncate">
                        {r.tag}
                      </span>
                    ) : null}
                  </div>
                  <span className="font-mono tabular text-base text-ink shrink-0">
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
