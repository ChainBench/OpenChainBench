import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { loadAlternativeSlugs } from "@/lib/alternatives";
import { fetchPerpVenueKpis } from "@/lib/perp-venue-data";
import { fetchPerpVenueExternalStats } from "@/lib/perp-venue-external";
import { findVenue, getPerpVolumeHistory } from "@/lib/perp-volume-history";
import { PERP_VENUES } from "@/lib/perp-stats";
import { loadBenchFromBlob } from "@/lib/bench-blob";
import { logoPath } from "@/lib/logo-manifest";
import { PerpVenueKpiStrip } from "@/components/perp-venue-kpi-strip";
import { PerpBarChart } from "@/components/perp-bar-chart";
import {
  PerpVenueBenchCards,
  type PerpVenueBenchRow,
} from "@/components/perp-venue-bench-cards";

/**
 * Perp venue view on /products/<slug>, behind the "Perpetuals" pill.
 * This is the whole former /perp/<slug> page folded into the product
 * page (2026-09-17): a product belongs to several categories, so the
 * product page is the one canonical surface and each category is a
 * view on it. /perp/<slug> now 308s here.
 *
 * Composition top to bottom:
 *   1. Heading + chain badge + external link
 *   2. Live KPI strip (6 adaptive cards)
 *   3. Venue data (extra KPIs from the venue's own API)
 *   4. Historical: daily volume (bench 266 history, else the cohort
 *      ring, else the venue API) and daily fees
 *   5. All-time totals, protocol / vault figures, collateral table
 *   6. OpenChainBench bench cards (perp-fees, perp-funding, ...)
 *   7. Other perp venues sharing benchmarks
 *   8. Footer cross-links
 *
 * Hide-if-empty: when the KPI feed returns null AND no bench row has a
 * measured value AND the venue API has nothing, the section returns
 * null so a half-broken venue stays off the page.
 *
 * Server component. Every fetch is an unstable_cache entry shared with
 * the /perps hub, so cold renders stay inside the page's ISR budget.
 */

export type PerpVenueSectionProps = {
  slug: string;
  /** Human-readable name shown in the heading. */
  name: string;
  /** Chain badge label, e.g. "Hyperliquid L1", "Arbitrum". */
  chainLabel: string;
  /** External site URL, e.g. "https://hyperliquid.xyz". */
  externalUrl: string;
  /** Cohort slug for the bench rows (gmx-v2 for the GMX entry). */
  cohortSlug: string;
  /** Per-bench cohort rows produced by the parent context (already
   *  warm in the same fetchPerpCohort cache as the hub). */
  benchRows: PerpVenueBenchRow[];
};

/** Benches whose results decide which other venues share a benchmark. */
const SHARED_BENCH_SLUGS = [
  "perp-fees",
  "perp-funding",
  "perp-active-markets",
  "perp-execution-quality",
  "perp-mark-price-lag",
  "perp-funding-stability",
  "perp-protocol-longevity",
  "perp-cost-slope",
  "perp-volume-share",
] as const;

export async function PerpVenueSection({
  slug,
  name,
  chainLabel,
  externalUrl,
  cohortSlug,
  benchRows,
}: PerpVenueSectionProps) {
  const [kpis, altSlugs, extRaw, volumeHistory, ...benchBlobs] = await Promise.all([
    fetchPerpVenueKpis(cohortSlug),
    loadAlternativeSlugs(),
    fetchPerpVenueExternalStats(cohortSlug),
    getPerpVolumeHistory(),
    ...SHARED_BENCH_SLUGS.map((s) => loadBenchFromBlob(s)),
  ]);
  const externalHost = safeHost(externalUrl);
  // Only emit /alternatives/<slug> when the YAML actually exists for
  // this venue; most cohort venues ship without one and a hardcoded
  // link leaked 404s into Google's crawl.
  const hasAlternativesPage = altSlugs.includes(slug);

  const measured = benchRows.filter(
    (r) => r.value !== null && r.rank !== null,
  );

  // Daily volume: bench 266 keeps a perps-only series per venue on closed
  // UTC days; when the venue is in that cohort it becomes the chart.
  // Otherwise the perp-volume-share ring (dailyVolumeSource "cohort"),
  // then the venue's own API. Cohort key for GMX is gmx-v2, history
  // slug is gmx.
  const historyVenue = volumeHistory
    ? findVenue(volumeHistory, cohortSlug === "gmx-v2" ? "gmx" : cohortSlug)
    : null;
  const useHistory = !!historyVenue && historyVenue.days.length >= 3;
  const ext = useHistory
    ? {
        ...extRaw,
        dailyVolumeChart: historyVenue!.days
          .slice(-30)
          .map((p) => ({ date: p.day, valueUsd: p.usd })),
      }
    : extRaw;
  const volumeChartTitle = useHistory
    ? "Daily perp volume (UTC days, bench 266)"
    : ext.dailyVolumeSource === "cohort"
      ? "Daily Volume (24h notional, OCB cohort)"
      : "Daily Volume";

  const hasChart =
    (ext.dailyVolumeChart?.length ?? 0) >= 3 ||
    (ext.dailyFeesChart?.length ?? 0) >= 3;
  const hasAllTime =
    ext.totalVolumeUsd != null ||
    ext.totalFeesUsd != null ||
    ext.totalTradeCount != null;
  const hasVault =
    ext.vaultTvlUsd != null ||
    ext.stakingAprPct != null ||
    (ext.collateralBreakdown?.length ?? 0) > 0;
  const hasExtra = (ext.extraKpis?.length ?? 0) > 0;

  if (!kpis && measured.length === 0 && !hasChart && !hasAllTime && !hasVault && !hasExtra) {
    return null;
  }

  const otherVenues = PERP_VENUES
    .filter((v) => v.slug !== cohortSlug)
    .map((v) => ({
      ...v,
      sharedCount: benchBlobs.filter(
        (b) => b && b.results.some((r) => r.slug === v.slug),
      ).length,
    }))
    .filter((v) => v.sharedCount > 0)
    .sort((a, b) => b.sharedCount - a.sharedCount);

  return (
    <section
      id={slug}
      className="scroll-mt-24 py-10 border-t border-ink/8 first:border-0"
    >
      <header className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-2xl sm:text-3xl font-semibold display tracking-tight">
            {name}
          </h2>
          <span
            className="label-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md border border-ink/15 text-ink-faint"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            {chainLabel}
          </span>
          <span className="text-sm text-ink-muted">Perpetual DEX tracked by OpenChainBench</span>
        </div>
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-ink-faint hover:text-ink underline underline-offset-2"
        >
          Open {externalHost}
        </a>
      </header>

      {kpis && (
        <div className="mb-8">
          <SectionLabel>Live KPIs</SectionLabel>
          <PerpVenueKpiStrip kpis={kpis} />
        </div>
      )}

      {hasExtra && (
        <div className="mb-8">
          <SectionLabel>Venue data</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {ext.extraKpis!.map((kpi) => (
              <div
                key={kpi.label}
                className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
                style={{ minHeight: 88 }}
              >
                <p
                  className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                >
                  {kpi.label}
                </p>
                <p className="mt-auto text-lg font-semibold tabular-nums leading-tight">
                  {kpi.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasChart && (
        <div className="mb-8">
          <SectionLabel>Historical</SectionLabel>
          <div
            className={`grid gap-6 ${ext.dailyVolumeChart && ext.dailyFeesChart ? "sm:grid-cols-2" : "grid-cols-1"}`}
          >
            {(ext.dailyVolumeChart?.length ?? 0) >= 3 && (
              <div className="card-soft rounded-lg p-4 border border-ink/15">
                <PerpBarChart bars={ext.dailyVolumeChart!} title={volumeChartTitle} color="teal" />
              </div>
            )}
            {(ext.dailyFeesChart?.length ?? 0) >= 3 && (
              <div className="card-soft rounded-lg p-4 border border-ink/15">
                <PerpBarChart bars={ext.dailyFeesChart!} title="Daily Fees" color="cyan" />
              </div>
            )}
          </div>
        </div>
      )}

      {hasAllTime && (
        <div className="mb-8">
          <SectionLabel>All-time</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {ext.totalVolumeUsd != null && (
              <StatCard label="Total Volume" value={fmtUSD(ext.totalVolumeUsd)} accent="teal" />
            )}
            {ext.totalFeesUsd != null && (
              <StatCard label="Total Fees" value={fmtUSD(ext.totalFeesUsd)} accent="cyan" />
            )}
            {ext.totalTradeCount != null && (
              <StatCard label="Total Trades" value={fmtCount(ext.totalTradeCount)} accent="indigo" />
            )}
          </div>
        </div>
      )}

      {hasVault && (
        <div className="mb-8">
          <SectionLabel>Protocol</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {ext.vaultTvlUsd != null && (
              <StatCard label="Vault TVL" value={fmtUSD(ext.vaultTvlUsd)} accent="teal" />
            )}
            {ext.stakingAprPct != null && (
              <StatCard label="Staking APR" value={fmtPct(ext.stakingAprPct)} accent="cyan" />
            )}
          </div>
          {(ext.collateralBreakdown?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-lg border border-rule overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule bg-paper-soft">
                    <Th align="left">Collateral</Th>
                    <Th align="right">TVL</Th>
                    <Th align="right">APR</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {ext.collateralBreakdown!.map((cr) => (
                    <tr key={cr.symbol} className="hover:bg-paper-soft/50 transition-colors">
                      <td className="px-4 py-3 font-medium">{cr.symbol}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{fmtUSD(cr.tvlUsd)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-good">{fmtPct(cr.aprPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {measured.length > 0 && (
        <div className="mb-8">
          <SectionLabel>OpenChainBench measurements</SectionLabel>
          <PerpVenueBenchCards rows={measured} />
        </div>
      )}

      {otherVenues.length > 0 && (
        <div className="mb-8">
          <SectionLabel>Other perp venues on the same benchmarks</SectionLabel>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {otherVenues.map((v) => {
              const productSlug = v.slug === "gmx-v2" ? "gmx" : v.slug;
              const lp = logoPath(v.slug);
              return (
                <li key={v.slug}>
                  <Link
                    href={`/products/${productSlug}#perp`}
                    className="card-soft p-4 flex items-center gap-3 h-full hover:border-ink/40 transition-colors"
                  >
                    {lp ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={lp} alt={v.name} width={32} height={32} className="rounded object-contain shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded bg-paper-soft border border-rule flex items-center justify-center text-xs font-semibold text-ink-soft shrink-0">
                        {v.name[0]}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink leading-tight truncate">{v.name}</p>
                      <p className="font-sans text-[10px] uppercase tracking-[0.16em] text-ink-faint font-medium">
                        {v.sharedCount} shared {v.sharedCount === 1 ? "benchmark" : "benchmarks"}
                      </p>
                    </div>
                    <ArrowUpRight size={14} strokeWidth={2} className="shrink-0 text-ink-faint" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-4 text-[12px] text-ink-faint pt-4 border-t border-ink/8">
        <Link href="/perps" className="hover:text-ink underline underline-offset-2">
          All perp venues
        </Link>
        <span aria-hidden>·</span>
        <Link href="/benchmarks/perp-fees" className="hover:text-ink underline underline-offset-2">
          Perp fees bench
        </Link>
        <span aria-hidden>·</span>
        <Link href="/benchmarks/perp-funding" className="hover:text-ink underline underline-offset-2">
          Funding bench
        </Link>
        {hasAlternativesPage && (
          <>
            <span aria-hidden>·</span>
            <Link href={`/alternatives/${slug}`} className="hover:text-ink underline underline-offset-2">
              {name} alternatives
            </Link>
          </>
        )}
        <span aria-hidden>·</span>
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-ink underline underline-offset-2"
        >
          {externalHost}
          <ArrowUpRight size={11} strokeWidth={2} />
        </a>
        {slug === "hyperliquid" && (
          <>
            <span aria-hidden>·</span>
            <Link href="/hyperliquid" className="hover:text-ink underline underline-offset-2">
              Hyperliquid frontends on /hyperliquid
            </Link>
          </>
        )}
      </footer>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="label-mono text-[10px] uppercase tracking-wide text-ink-faint mb-3"
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {children}
    </p>
  );
}

function Th({ children, align }: { children: React.ReactNode; align: "left" | "right" }) {
  return (
    <th
      className={`${align === "left" ? "text-left" : "text-right"} px-4 py-2.5 text-[10px] uppercase tracking-wide text-ink-faint font-medium`}
      style={{ fontFamily: "var(--font-mono, monospace)" }}
    >
      {children}
    </th>
  );
}

function StatCard({
  label,
  value,
  accent = "teal",
}: {
  label: string;
  value: string;
  accent?: "teal" | "cyan" | "indigo";
}) {
  const dot = accent === "cyan" ? "#06b6d4" : accent === "indigo" ? "#6366f1" : "#14b8a6";
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15 flex flex-col"
      style={{ minHeight: 88 }}
    >
      <div className="flex items-center justify-between gap-1 mb-1">
        <p
          className="text-[10px] text-ink-faint uppercase tracking-wide leading-snug"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {label}
        </p>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} aria-hidden />
      </div>
      <p className="mt-auto text-lg sm:text-xl font-semibold tabular-nums leading-tight">{value}</p>
    </div>
  );
}

function fmtUSD(v: number | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return "-";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v.toFixed(1)}%`;
}

function fmtCount(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
