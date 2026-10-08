import Link from "next/link";
import type { HlBuilderStats } from "@/lib/hl-builder-stats";
import { HlPerformanceChart } from "@/components/hl-performance-chart";
import { HlCoinDistribution } from "@/components/hl-coin-distribution";
import { HlUserPercentile } from "@/components/hl-user-percentile";
import { HlTopUsersTable } from "@/components/hl-top-users-table";
import { HlFeedCoverageNote } from "@/components/hl-feed-coverage-note";
import { HlKpiStrip } from "@/components/hl-kpi-strip";

/**
 * Per-builder HyperTracker-parity dashboard on /products/[slug].
 *
 * Layout (top → bottom):
 *  1. KPI strip (Revenue / Volume / Users / $-per-user / Annualised /
 *     cohort share)
 *  2. Performance chart (30d daily revenue bars + users line)
 *  3. Distribution row: coin donut + user percentile bar
 *  4. Milestones row (biggest day, $10k/$100k/$1m crossings)
 *  5. Top-traders leaderboard (paginated, 30d window)
 *
 * Server-rendered against the Sprint-1+2 Prom gauges exposed by the
 * feed harness. Charts that depend on the harness JSON endpoints
 * (`daily-series`, `top-users`) are client components and degrade
 * silently when the upstream is unreachable.
 */

export function HlBuilderDashboard({
  stats,
  name,
}: {
  stats: HlBuilderStats;
  name: string;
}) {
  const hasDistribution =
    stats.coinShares24h.length > 0 ||
    stats.percentileShares30d.some((b) => b.share > 0);

  return (
    <section className="mt-8 mb-12">
      <HlFeedCoverageNote feed={stats.feed} className="mb-4 max-w-3xl" />

      <HlKpiStrip stats={stats} />

      <HlPerformanceChart
        slug={stats.slug}
        biggestDayUnix={stats.biggestDayUnix}
      />

      {hasDistribution && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {stats.coinShares24h.length > 0 && (
            <HlCoinDistribution shares={stats.coinShares24h} />
          )}
          {stats.percentileShares30d.some((b) => b.share > 0) && (
            <HlUserPercentile
              shares={stats.percentileShares30d}
              profitablePct={stats.profitableUserPct30d}
            />
          )}
        </div>
      )}

      {(stats.biggestDayRevenue > 0 ||
        stats.milestoneDays["10k"] >= 0 ||
        stats.milestoneDays["100k"] >= 0 ||
        stats.milestoneDays["1m"] >= 0) && (
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          {stats.biggestDayRevenue > 0 && (
            <Milestone
              // "Biggest day" was the wrong promise while the upstream feed
              // publishes partial days: a maximum over days of unequal length
              // ranks coverage, not activity. The harness now picks the
              // biggest day the feed carried whole, so the card says that.
              label={
                stats.feed && stats.feed.truncatedDaysWindow > 0
                  ? "Biggest complete day"
                  : "Biggest day"
              }
              value={fmtUSD(stats.biggestDayRevenue)}
              detail={
                stats.biggestDayUnix > 0
                  ? new Date(stats.biggestDayUnix * 1000)
                      .toISOString()
                      .slice(0, 10)
                  : undefined
              }
              tip={
                stats.feed && stats.feed.truncatedDaysWindow > 0
                  ? "Highest single UTC day the per-builder feed published in full. Days the feed cut short are skipped: their totals are lower bounds and cannot be compared against a whole day."
                  : undefined
              }
            />
          )}
          {stats.milestoneDays["10k"] >= 0 && (
            <Milestone
              label="$10k milestone"
              value={`Day ${stats.milestoneDays["10k"]}`}
              detail="since first observed fill"
            />
          )}
          {stats.milestoneDays["100k"] >= 0 && (
            <Milestone
              label="$100k milestone"
              value={`Day ${stats.milestoneDays["100k"]}`}
              detail="since first observed fill"
            />
          )}
          {stats.milestoneDays["1m"] >= 0 && (
            <Milestone
              label="$1m milestone"
              value={`Day ${stats.milestoneDays["1m"]}`}
              detail="since first observed fill"
            />
          )}
        </div>
      )}

      <HlTopUsersTable slug={stats.slug} />

      <p className="mt-4 text-[11px] text-ink-faint italic">
        Source: Hyperliquid&apos;s public per-builder daily fills feed for{" "}
        {name}&apos;s builder address, last complete UTC day. Methodology:{" "}
        <Link href="/benchmarks/hyperliquid-frontends" className="underline">
          hyperliquid-frontends bench page
        </Link>
        .
      </p>
    </section>
  );
}

function Milestone({
  label,
  value,
  detail,
  tip,
}: {
  label: string;
  value: string;
  detail?: string;
  tip?: string;
}) {
  return (
    <div className="card-soft rounded-lg p-3 border border-ink/10" title={tip}>
      <p className="label-mono text-[10px] text-ink-faint mb-1">{label}</p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
      {detail && <p className="text-[11px] text-ink-faint mt-0.5">{detail}</p>}
    </div>
  );
}

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}



