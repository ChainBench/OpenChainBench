import Link from "next/link";
import { fetchPmCohort, type PmCohortSummary, type PmVenueRow, type PmDataFeedRow } from "@/lib/pm-stats";
import { PmHubTabs } from "@/components/pm-hub-tabs";
import { PmVenueSection } from "@/components/pm-venue-section";
import { PmDataFeedSection } from "@/components/pm-data-feed-section";
import type { PmVenueBenchRow } from "@/components/pm-venue-bench-cards";
import { pageMetadata } from "@/lib/page-metadata";
import { safeJsonLd, buildBreadcrumbJsonLd } from "@/lib/jsonld";
import { SITE } from "@/data/site";

/**
 * Mapping from registry venue slug → external homepage URL + display
 * chain label. Drives the per-venue anchored section heading + the
 * "View on X" external link. Hardcoded because the venue set is small
 * and rarely-changing; same shape as the harness Registry over in
 * mobula-monorepo/miniapps/pm-cohort-stats/.
 */
const VENUE_META: Record<string, { url: string; chainLabel: string }> = {
  polymarket: { url: "https://polymarket.com", chainLabel: "Polygon" },
  kalshi: { url: "https://kalshi.com", chainLabel: "Offchain US" },
  limitless: { url: "https://limitless.exchange", chainLabel: "Base" },
  manifold: { url: "https://manifold.markets", chainLabel: "Offchain play money" },
  myriad: { url: "https://myriad.markets", chainLabel: "Offchain multi chain" },
};

const FEED_META: Record<string, { url?: string; logoSrc?: string }> = {
  "polymarket-clob": { url: "https://polymarket.com", logoSrc: "/logos/polymarket.png" },
  mobula: { url: "https://mobula.io", logoSrc: "/logos/mobula.png" },
  codex: { url: "https://codex.io", logoSrc: "/logos/codex.png" },
};

/**
 * Hub landing page for the prediction markets cohort. SSR'd against
 * the `pm-cohort-stats` harness gauges plus the existing PM bench
 * gauges (pm-api-latency, pm-resolution-delay, pm-data-freshness). One
 * server fetch, one client tab swap between Venues and Data feeds.
 *
 * The page positions OCB as the neutral cross venue measurement layer:
 * resolution honesty, API quality, freshness lag, all on the same
 * timeline and with the same methodology. Per venue pages live on the
 * bench specs (`/benchmarks/pm-*`); cross venue context lives here.
 *
 * The hub renders gracefully before the harness goes live: every
 * numeric field is independently nullable, the leaderboard shows a row
 * of dashes for missing data, and the JSON-LD ItemList stays valid
 * because it lists venue identities, not metric values.
 */

const DESCRIPTION =
  "Live cross venue measurement of prediction markets: volume, open interest, resolution delay, API latency and data freshness. One leaderboard, one methodology, across Polymarket, Kalshi, Limitless, Manifold and Myriad.";

export const metadata: import("next").Metadata = pageMetadata({
  path: "/prediction-markets",
  title: "Prediction markets leaderboard",
  description: DESCRIPTION,
});

export const revalidate = 60;

export default async function PredictionMarketsHubPage() {
  const cohort = await fetchPmCohort();

  const breadcrumbLd = {
    "@context": "https://schema.org",
    ...buildBreadcrumbJsonLd([
      { name: "Home", item: SITE.url },
      { name: "Prediction markets", item: `${SITE.url}/prediction-markets` },
    ]),
  };

  // ItemList JSON-LD points at the bench pages for each venue rather
  // than a per venue product page, because OCB doesn't have one yet
  // (the bench pages are the canonical surface). Keeping this list
  // stable means the SERP card doesn't churn if the harness drops a
  // series momentarily.
  const itemListLd = cohort
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Prediction market venues tracked by OpenChainBench",
        description:
          "Prediction market venues tracked by OpenChainBench, with cross venue measurements of volume, resolution delay, API latency and data freshness.",
        numberOfItems: cohort.venues.length,
        itemListElement: cohort.venues.map((r, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: r.name,
          url: `${SITE.url}/benchmarks/pm-api-latency`,
        })),
      }
    : null;

  return (
    <article
      className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-16"
      style={{
        background:
          "linear-gradient(180deg, rgba(20,184,166,0.05), rgba(20,184,166,0) 320px)",
      }}
    >
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
        dangerouslySetInnerHTML={{ __html: safeJsonLd(breadcrumbLd) }}
      />
      {itemListLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized via safeJsonLd
          dangerouslySetInnerHTML={{ __html: safeJsonLd(itemListLd) }}
        />
      )}

      <header className="mb-8">
        <p className="label-mono text-teal-600 mb-2">Prediction markets</p>
        <h1 className="display text-4xl sm:text-5xl text-ink">
          Prediction markets, measured neutrally.
        </h1>
        <p className="mt-4 max-w-2xl text-base sm:text-lg text-ink-soft leading-snug">
          Every venue ranks itself on the metric it picks. OCB picks the
          metrics, then ranks every venue on the same axis: resolution
          honesty, API latency, data freshness. {DESCRIPTION}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <Link
            href="/benchmarks/pm-api-latency"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-api-latency</span>
          </Link>
          <Link
            href="/benchmarks/polymarket-resolution-delay"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-resolution-delay</span>
          </Link>
          <Link
            href="/benchmarks/pm-data-freshness"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-data-freshness</span>
          </Link>
          <Link
            href="/benchmarks/pm-rate-limits"
            className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 px-3 py-1 hover:bg-teal-500/15"
          >
            <span
              className="label-mono text-ink-faint text-[10px]"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Bench
            </span>
            <span className="text-ink">pm-rate-limits</span>
          </Link>
          <Link
            href="/methodology"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1 text-ink-soft hover:text-ink"
          >
            How OpenChainBench measures
          </Link>
        </div>
      </header>

      {cohort ? (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
            <SummaryCard
              label="Total volume 30d"
              value={fmtUSD(cohort.totals.volume30d)}
              accent="#14b8a6"
            />
            <SummaryCard
              label="Active markets"
              value={fmtCount(cohort.totals.activeMarkets)}
            />
            <SummaryCard
              label="Cohort median resolution"
              value={fmtMinutes(cohort.totals.medianResolutionDelayMin)}
              tip="Median of per venue median resolution delays, across the trailing 30 days."
            />
            <SummaryCard
              label="Cohort p50 API latency"
              value={fmtMs(cohort.totals.p50ApiLatencyMs)}
              tip="Median of per venue p50 latency on the warm price endpoint, trailing 24h."
            />
            <SummaryCard
              label="Tracked venues and feeds"
              value={`${cohort.venues.length} + ${cohort.dataFeeds.length}`}
            />
          </section>

          <PmHubTabs cohort={cohort} />

          <p className="mt-4 text-[11px] text-ink-faint italic">
            Source: pm-cohort-stats harness (volume, OI, active markets,
            top market, markets &gt;$1M) plus the live PM bench fleet
            (api latency, resolution delay, freshness). All gauges
            scraped from the public OCB Prom, refresh interval 60s.
          </p>

          {/* Anchored deep-dive sections, one per venue then one per
              data feed. Each section is reachable via the table row
              link in the tabs above (clicking a venue scrolls to its
              #slug section). Sections render gracefully when the
              underlying KPI fetch returns null. */}
          <div className="mt-12">
            <p
              className="label-mono text-[10px] text-ink-faint mb-2"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Venues in depth
            </p>
            {cohort.venues.map((v) => (
              <PmVenueSection
                key={v.slug}
                slug={v.slug}
                name={v.name}
                chainLabel={VENUE_META[v.slug]?.chainLabel ?? "Unknown"}
                externalUrl={VENUE_META[v.slug]?.url ?? "#"}
                venueType={v.type}
                benchRows={benchRowsForVenue(cohort, v)}
              />
            ))}
          </div>

          <div className="mt-12">
            <p
              className="label-mono text-[10px] text-ink-faint mb-2"
              style={{ fontFamily: "var(--font-mono, monospace)" }}
            >
              Data feeds in depth
            </p>
            {cohort.dataFeeds.map((f) => (
              <PmDataFeedSection
                key={f.slug}
                slug={f.slug}
                name={f.name}
                logoSrc={FEED_META[f.slug]?.logoSrc}
                externalUrl={FEED_META[f.slug]?.url}
                benchRows={benchRowsForDataFeed(f)}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-ink-faint italic">
          Cohort data is temporarily unavailable. The bench pages are
          still live at{" "}
          <Link href="/benchmarks/pm-api-latency" className="underline">
            /benchmarks/pm-api-latency
          </Link>
          ,{" "}
          <Link
            href="/benchmarks/polymarket-resolution-delay"
            className="underline"
          >
            /benchmarks/polymarket-resolution-delay
          </Link>
          ,{" "}
          <Link href="/benchmarks/pm-data-freshness" className="underline">
            /benchmarks/pm-data-freshness
          </Link>{" "}
          and{" "}
          <Link href="/benchmarks/pm-rate-limits" className="underline">
            /benchmarks/pm-rate-limits
          </Link>
          .
        </p>
      )}

      <footer className="mt-16 pt-6 border-t border-ink/10 text-[12px] text-ink-soft leading-relaxed">
        <p className="label-mono text-ink-faint mb-2">Methodology</p>
        <p>
          Venue rows aggregate the public APIs of each platform, normalized
          to USD and UTC days. Resolution delay comes from the
          pm-resolution-delay bench (anchor: ProposePrice for UMA backed
          markets). API latency is the 24h p50 of warm, non cached price
          requests from us-east, eu-west and Singapore. Freshness compares
          third party relays against the Polymarket CLOB T0 stream.
        </p>
        <p className="mt-3">
          Data and methodology released under{" "}
          <Link
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </Link>
          . Reuse with attribution to OpenChainBench.
        </p>
      </footer>
    </article>
  );
}

/**
 * Construct the bench-card rows for one venue from the cohort summary.
 * The venue row already carries the per-bench numbers we want to show
 * (median resolution delay from #039, p50 API latency from #038);
 * everything else is null until the corresponding gauge is in scope.
 */
function benchRowsForVenue(
  cohort: PmCohortSummary,
  venue: PmVenueRow,
): PmVenueBenchRow[] {
  const cohortSize = cohort.venues.length;
  return [
    {
      benchSlug: "pm-api-latency",
      label: "API latency",
      blurb: "Warm price endpoint, 24h p50 across 3 regions.",
      rank: rankWithinCohort(cohort.venues, "p50ApiLatencyMs", venue.slug, false),
      cohortSize,
      value: fmtMs(venue.p50ApiLatencyMs),
      vsMedian: null,
      tone: "teal",
    },
    {
      benchSlug: "polymarket-resolution-delay",
      label: "Resolution delay",
      blurb: "ProposePrice anchor to QuestionResolved block, median.",
      rank: rankWithinCohort(cohort.venues, "medianResolutionDelayMin", venue.slug, false),
      cohortSize,
      value: fmtMinutes(venue.medianResolutionDelayMin),
      vsMedian: null,
      tone: "cyan",
    },
    {
      benchSlug: "pm-data-freshness",
      label: "Data freshness",
      blurb: "Third party relays vs the venue's canonical T0 stream.",
      rank: null,
      cohortSize,
      value: null,
      vsMedian: null,
      tone: "indigo",
    },
    {
      benchSlug: "pm-rate-limits",
      label: "Rate limits",
      blurb: "Warm endpoint behavior under daily ramp tests.",
      rank: null,
      cohortSize,
      value: null,
      vsMedian: null,
      tone: "violet",
    },
  ];
}

/**
 * Construct the bench-card rows for one data feed. Data freshness is the
 * relevant bench (032). The reference feed (Polymarket CLOB) is
 * special-cased inside <PmDataFeedSection> to render a T0 badge.
 */
function benchRowsForDataFeed(feed: PmDataFeedRow): PmVenueBenchRow[] {
  return [
    {
      benchSlug: "pm-data-freshness",
      label: "Freshness vs T0",
      blurb: "Lag between this relay and Polymarket CLOB T0.",
      rank: null,
      cohortSize: 0,
      value: feed.isReference ? null : fmtMs(feed.freshnessP50Ms),
      vsMedian: null,
      tone: "indigo",
    },
  ];
}

function rankWithinCohort(
  venues: PmVenueRow[],
  key: "p50ApiLatencyMs" | "medianResolutionDelayMin",
  slug: string,
  higherIsBetter: boolean,
): number | null {
  const populated = venues
    .map((r) => ({ slug: r.slug, v: r[key] }))
    .filter((r) => r.v != null && Number.isFinite(r.v as number));
  if (populated.length === 0) return null;
  populated.sort((a, b) =>
    higherIsBetter ? (b.v as number) - (a.v as number) : (a.v as number) - (b.v as number),
  );
  const idx = populated.findIndex((r) => r.slug === slug);
  return idx >= 0 ? idx + 1 : null;
}

function SummaryCard({
  label,
  value,
  accent,
  tip,
}: {
  label: string;
  value: string;
  accent?: string;
  tip?: string;
}) {
  return (
    <div
      className="card-soft rounded-lg p-3 sm:p-4 border border-ink/15"
      title={tip}
    >
      <p
        className="label-mono text-[10px] text-ink-faint mb-1 flex items-center gap-1.5"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {accent && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: accent }}
          />
        )}
        {label}
      </p>
      <p className="text-lg sm:text-2xl font-semibold tabular-nums leading-tight">
        {value}
      </p>
    </div>
  );
}

function fmtUSD(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtCount(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
}

function fmtMinutes(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 60) return `${v.toFixed(1)}m`;
  const h = v / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function fmtMs(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "...";
  if (v < 1) return `${(v * 1000).toFixed(0)}us`;
  if (v < 1000) return `${v.toFixed(0)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}
