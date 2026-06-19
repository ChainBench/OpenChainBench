import Link from "next/link";
import type { HlBuilderStats } from "@/lib/benches/hyperliquid/builder-stats";
import { HlPerformanceChart } from "@/components/benches/hyperliquid/performance-chart";
import { HlCoinDistribution } from "@/components/benches/hyperliquid/coin-distribution";
import { HlUserPercentile } from "@/components/benches/hyperliquid/user-percentile";
import { HlTopUsersTable } from "@/components/benches/hyperliquid/top-users-table";

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
 * on-node harness. Charts that depend on the harness JSON endpoints
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
      <p className="label-mono text-ink-faint mb-3">
        Hyperliquid frontend dashboard
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          label="Revenue 30d"
          value={fmtUSD(stats.revenue30d)}
          delta={stats.revenueDelta30d}
          tone="primary"
        />
        <KpiCard
          label="Volume 30d"
          value={fmtUSD(stats.volume30d)}
          tone="primary"
        />
        <KpiCard
          label="Users 30d"
          value={fmtCount(stats.users30d)}
          tone="primary"
        />
        <KpiCard
          label="$ / user 30d"
          value={fmtUSD(stats.feesPerUser30d)}
        />
        <KpiCard
          label="Annualised"
          value={fmtUSD(stats.annualisedRevenue)}
          tip="Projection: revenue × 365/30"
        />
        <KpiCard
          label="% cohort 24h vol"
          value={fmtPct(stats.cohortVolumeShare24h)}
          tip="Share of the 104 tracked builders' 24h notional volume"
        />
      </div>

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
              label="Biggest day"
              value={fmtUSD(stats.biggestDayRevenue)}
              detail={
                stats.biggestDayUnix > 0
                  ? new Date(stats.biggestDayUnix * 1000)
                      .toISOString()
                      .slice(0, 10)
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
        Source: local hl node tailing every fill on Hyperliquid mainnet for{" "}
        {name}&apos;s builder address. Refresh every 30s. Methodology:{" "}
        <Link href="/benchmarks/hyperliquid-frontends" className="underline">
          hyperliquid-frontends bench page
        </Link>
        .
      </p>
    </section>
  );
}

function KpiCard({
  label,
  value,
  delta,
  tip,
  tone,
}: {
  label: string;
  value: string;
  delta?: number;
  tip?: string;
  tone?: "primary";
}) {
  const arrowTone =
    delta === undefined
      ? ""
      : delta > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : delta < 0
          ? "text-red-600 dark:text-red-400"
          : "text-ink-faint";
  return (
    <div
      className={
        "card-soft rounded-lg p-3 sm:p-4 " +
        (tone === "primary"
          ? "border border-ink/15"
          : "border border-ink/8")
      }
      title={tip}
    >
      <p className="label-mono text-[10px] text-ink-faint mb-1">{label}</p>
      <p className="text-lg sm:text-xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
      {delta !== undefined && (
        <p className={`mt-0.5 text-xs ${arrowTone}`}>{fmtDelta(delta)}</p>
      )}
    </div>
  );
}

function Milestone({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="card-soft rounded-lg p-3 border border-ink/10">
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

function fmtCount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0%";
  const pct = v * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

function fmtDelta(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0%";
  const pct = v * 100;
  const sign = v > 0 ? "+" : "";
  if (Math.abs(pct) >= 10) return `${sign}${pct.toFixed(0)}%`;
  return `${sign}${pct.toFixed(1)}%`;
}
