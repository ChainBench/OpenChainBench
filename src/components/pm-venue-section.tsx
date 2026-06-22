import Link from "next/link";
import {
  deriveCategoryShares,
  fetchPmTopMarkets,
  fetchPmVenueHistory,
  fetchPmVenueKpis,
} from "@/lib/pm-venue-data";
import { PmVenueKpiStrip, type PmVenueType } from "@/components/pm-venue-kpi-strip";
import {
  PmVenueBenchCards,
  type PmVenueBenchRow,
} from "@/components/pm-venue-bench-cards";
import { PmTopMarketsTable } from "@/components/pm-top-markets-table";
import { PmCategoryDonut } from "@/components/pm-category-donut";
import { PmVolumeOiChart } from "@/components/pm-volume-oi-chart";

/**
 * Per-venue anchored section on /prediction-markets. URL anchor is the
 * venue slug, so `?#polymarket` jumps straight to this section.
 *
 * Composition top to bottom:
 *   1. Heading + chain badge + external link
 *   2. KPI strip (6 adaptive cards)
 *   3. Bench cards row (one per PM bench, links to the leaderboard)
 *   4. 90d volume + OI chart (hidden if history not backfilled)
 *   5. Two-column row: top markets table (left) + category donut (right)
 *   6. Cross-link footer: /products/<slug>, /alternatives/<slug>, external
 *
 * Server component. The four async fetchers fan out in parallel via
 * Promise.all so cold renders stay under the page-level ISR budget.
 */

export type PmVenueSectionProps = {
  slug: string;
  /** Human-readable name shown in the heading. */
  name: string;
  /** Chain badge label, e.g. "Polygon", "Solana", "Offchain". */
  chainLabel: string;
  /** External site URL, e.g. "https://polymarket.com". */
  externalUrl: string;
  /** Onchain vs offchain selects the KPI card mix. */
  venueType: PmVenueType;
  /** Per-bench cohort rows produced by the parent page (it already has
   *  the bench data warm for the table at the top of the hub). */
  benchRows: PmVenueBenchRow[];
};

export async function PmVenueSection({
  slug,
  name,
  chainLabel,
  externalUrl,
  venueType,
  benchRows,
}: PmVenueSectionProps) {
  const [kpis, topMarkets, history] = await Promise.all([
    fetchPmVenueKpis(slug),
    fetchPmTopMarkets(slug),
    fetchPmVenueHistory(slug, 90),
  ]);

  const categoryShares = deriveCategoryShares(topMarkets);
  const externalHost = safeHost(externalUrl);

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

      {kpis ? (
        <div className="mb-6">
          <p
            className="label-mono text-[10px] text-ink-faint mb-3"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          >
            Live KPIs
          </p>
          <PmVenueKpiStrip kpis={kpis} venueType={venueType} />
        </div>
      ) : (
        <div className="mb-6 card-soft rounded-xl p-4 border border-ink/10 text-sm text-ink-faint italic">
          Live KPI feed for {name} not wired yet. Bench leaderboards below
          still reflect the latest cohort run.
        </div>
      )}

      {(() => {
        // Only render bench cards that actually have a measurement.
        // Empty "Not measured yet" rows used to fill the section on
        // venues whose probes had not landed and made the page read as
        // half-broken.
        const measured = benchRows.filter(
          (r) => r.value !== null && r.rank !== null,
        );
        if (measured.length === 0) return null;
        return (
          <div className="mb-6">
            <p
              className="label-mono text-[10px] text-ink-faint mb-3"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              OpenChainBench measurements
            </p>
            <PmVenueBenchCards rows={measured} />
          </div>
        );
      })()}

      {history && history.points.length >= 7 && (
        <div className="mb-6">
          <PmVolumeOiChart history={history} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2">
          <PmTopMarketsTable markets={topMarkets} venueLabel={name} />
        </div>
        <div>
          {categoryShares ? (
            <PmCategoryDonut shares={categoryShares} />
          ) : (
            <div className="card-soft rounded-xl p-6 border border-ink/10 h-full text-sm text-ink-faint italic">
              Category split feed not live yet.
            </div>
          )}
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-4 text-[12px] text-ink-faint pt-4 border-t border-ink/8">
        <Link
          href={`/products/${slug}`}
          className="hover:text-ink underline underline-offset-2"
        >
          {name} product page
        </Link>
        <span aria-hidden>·</span>
        <Link
          href={`/alternatives/${slug}`}
          className="hover:text-ink underline underline-offset-2"
        >
          {name} alternatives
        </Link>
        <span aria-hidden>·</span>
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-ink underline underline-offset-2"
        >
          View on {externalHost}
        </a>
      </footer>
    </section>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
