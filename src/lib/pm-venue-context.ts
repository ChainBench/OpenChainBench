import {
  fetchPmCohort,
  type PmCohortSummary,
  type PmDataFeedRow,
  type PmVenueRow,
  type PmVenueType,
} from "@/lib/pm-stats";
import type { PmVenueBenchRow } from "@/components/pm-venue-bench-cards";
import { logoPath } from "@/lib/logo-manifest";

/**
 * Per-venue and per-feed metadata for the prediction-markets cohort.
 * Hardcoded because the venue set is small, curated, and shared with
 * the bench specs (`upstream-monorepo/miniapps/pm-cohort-stats/`).
 *
 * Used by both the /prediction-markets hub leaderboard (for the venue
 * row link + chain badge) and the /products/<slug> page (to inject the
 * full PM venue dashboard when the slug matches a tracked venue).
 */

// A slug missing here gets no PM dashboard at all: getPmVenueContext
// returns null before it ever looks at the cohort. Keep it in step with
// PM_VENUES in pm-stats.ts and the harness registry.
export const PM_VENUE_META: Record<string, { url: string; chainLabel: string }> = {
  polymarket: { url: "https://polymarket.com", chainLabel: "Polygon" },
  "polymarket-us": { url: "https://polymarketexchange.com", chainLabel: "Offchain US" },
  kalshi: { url: "https://kalshi.com", chainLabel: "Offchain US" },
  limitless: { url: "https://limitless.exchange", chainLabel: "Base" },
  myriad: { url: "https://myriad.markets", chainLabel: "Abstract L2" },
  manifold: { url: "https://manifold.markets", chainLabel: "Offchain" },
  predictit: { url: "https://www.predictit.org", chainLabel: "Offchain US" },
  smarkets: { url: "https://smarkets.com", chainLabel: "Offchain UK" },
  metaculus: { url: "https://www.metaculus.com", chainLabel: "Offchain" },

  // Bench 277 cohort. Chain labels name every deployment for the
  // multi-chain ones rather than the largest, because this string is
  // the page's only answer to "where does this run".
  rain: { url: "https://www.rain.one", chainLabel: "Arbitrum" },
  "predict-fun": { url: "https://predict.fun", chainLabel: "BNB Chain, Blast" },
  opinion: { url: "https://app.opinion.trade", chainLabel: "BNB Chain" },
  "sport-fun": { url: "https://pro.sport.fun", chainLabel: "Base" },
  augur: { url: "https://augur.net", chainLabel: "Ethereum" },
  "levr-bet": { url: "https://levr.bet", chainLabel: "Monad" },
  predictstreet: { url: "https://adipredictstreet.com", chainLabel: "ADI Chain" },
  pascal: { url: "https://www.pascal.trade", chainLabel: "Solana" },
  overtime: {
    url: "https://www.overtimemarkets.xyz",
    chainLabel: "Optimism, Arbitrum, Polygon, Base, Ethereum, BNB Chain",
  },
  trueo: { url: "https://trueo.com", chainLabel: "Base" },
  azuro: {
    url: "https://azuro.org",
    chainLabel: "Polygon, Base, Chiliz, Linea, Arbitrum, Gnosis",
  },
};

export const PM_FEED_META: Record<string, { url?: string }> = {
  "polymarket-clob": { url: "https://polymarket.com" },
};

export type PmVenueContext = {
  kind: "venue";
  slug: string;
  name: string;
  chainLabel: string;
  externalUrl: string;
  venueType: PmVenueType;
  benchRows: PmVenueBenchRow[];
};

export type PmDataFeedContext = {
  kind: "feed";
  slug: string;
  name: string;
  logoSrc?: string;
  externalUrl?: string;
  benchRows: PmVenueBenchRow[];
};

/**
 * Resolve a provider slug to a PM venue or data feed context, or null
 * if the slug isn't part of the PM cohort. One Prom round-trip via
 * `fetchPmCohort()` (cached at the request level), then the row is
 * looked up in memory.
 */
export async function getPmVenueContext(
  slug: string,
): Promise<PmVenueContext | PmDataFeedContext | null> {
  if (!PM_VENUE_META[slug] && !PM_FEED_META[slug]) return null;

  const cohort = await fetchPmCohort();
  if (!cohort) return null;

  const venue = cohort.venues.find((v) => v.slug === slug);
  if (venue) {
    const meta = PM_VENUE_META[slug];
    return {
      kind: "venue",
      slug,
      name: venue.name,
      chainLabel: meta?.chainLabel ?? "Unknown",
      externalUrl: meta?.url ?? "#",
      venueType: venue.type,
      benchRows: benchRowsForVenue(cohort, venue),
    };
  }

  const feed = cohort.dataFeeds.find((f) => f.slug === slug);
  if (feed) {
    const meta = PM_FEED_META[slug];
    return {
      kind: "feed",
      slug,
      name: feed.name,
      logoSrc: logoPath(slug) ?? undefined,
      externalUrl: meta?.url,
      benchRows: benchRowsForDataFeed(feed),
    };
  }

  return null;
}

export function benchRowsForVenue(
  cohort: PmCohortSummary,
  venue: PmVenueRow,
): PmVenueBenchRow[] {
  // Each card's population is the set of venues that publish that
  // metric, never the registry length: six venues have an API latency,
  // so "3 of 20" would be a claim about fourteen venues that were never
  // measured.
  const oi = rankWithinCohort(cohort.venues, "openInterest", venue.slug, "desc");
  const turn = rankWithinCohort(cohort.venues, "turnover24h", venue.slug, "desc");
  const api = rankWithinCohort(cohort.venues, "p50ApiLatencyMs", venue.slug);
  const res = rankWithinCohort(cohort.venues, "medianResolutionDelayMin", venue.slug);
  return [
    {
      benchSlug: "pm-open-interest",
      label: "Open interest",
      blurb: "Capital held against open positions, 24h average.",
      rank: oi.rank,
      cohortSize: oi.of,
      value: fmtUSD(venue.openInterest),
      vsMedian: null,
      tone: "teal",
    },
    {
      benchSlug: "pm-open-interest",
      label: "Turnover",
      blurb: "24h volume over open interest: how often the book turns.",
      rank: turn.rank,
      cohortSize: turn.of,
      value: fmtTurnover(venue.turnover24h),
      vsMedian: null,
      tone: "cyan",
    },
    {
      benchSlug: "pm-api-latency",
      label: "API latency",
      blurb: "Warm price endpoint, 24h p50 across 3 regions.",
      rank: api.rank,
      cohortSize: api.of,
      value: fmtMs(venue.p50ApiLatencyMs),
      vsMedian: null,
      tone: "indigo",
    },
    {
      benchSlug: "pm-resolution-delay",
      label: "Resolution delay",
      blurb: "ProposePrice anchor to QuestionResolved block, median.",
      rank: res.rank,
      cohortSize: res.of,
      value: fmtMinutes(venue.medianResolutionDelayMin),
      vsMedian: null,
      tone: "violet",
    },
    {
      benchSlug: "pm-ws-latency",
      label: "WS latency",
      blurb: "Connect-to-snapshot and trade publication lag on the venue WebSocket.",
      rank: null,
      cohortSize: 0,
      value: null,
      vsMedian: null,
      tone: "indigo",
    },
    {
      benchSlug: "pm-rate-limits",
      label: "Rate limits",
      blurb: "Warm endpoint behavior under daily ramp tests.",
      rank: null,
      cohortSize: 0,
      value: null,
      vsMedian: null,
      tone: "violet",
    },
  ];
}

export function benchRowsForDataFeed(feed: PmDataFeedRow): PmVenueBenchRow[] {
  return [
    {
      benchSlug: "pm-ws-latency",
      label: "WS latency",
      blurb: "Venue WebSocket connect-to-snapshot and trade publication lag.",
      rank: null,
      cohortSize: 0,
      value: feed.isReference ? null : fmtMs(feed.freshnessP50Ms),
      vsMedian: null,
      tone: "indigo",
    },
  ];
}

/**
 * Rank a venue on one metric, and report the population the rank is out
 * of. The two must travel together: a rank taken over the venues that
 * publish a metric, printed against the size of the whole registry,
 * silently claims the unmeasured venues were measured and lost.
 *
 * `dir` is "asc" where lower is better (latency, resolution delay) and
 * "desc" where higher is (open interest, turnover).
 */
function rankWithinCohort(
  venues: PmVenueRow[],
  key: "p50ApiLatencyMs" | "medianResolutionDelayMin" | "openInterest" | "turnover24h",
  slug: string,
  dir: "asc" | "desc" = "asc",
): { rank: number | null; of: number } {
  const populated = venues
    .map((r) => ({ slug: r.slug, v: r[key] }))
    .filter((r) => r.v != null && Number.isFinite(r.v as number));
  if (populated.length === 0) return { rank: null, of: 0 };
  const sign = dir === "desc" ? -1 : 1;
  populated.sort((a, b) => sign * ((a.v as number) - (b.v as number)));
  const idx = populated.findIndex((r) => r.slug === slug);
  return { rank: idx >= 0 ? idx + 1 : null, of: populated.length };
}

function fmtUSD(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtTurnover(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v > 0 && v < 0.01) return "<0.01\u00d7";
  return v < 10 ? `${v.toFixed(2)}\u00d7` : `${v.toFixed(1)}\u00d7`;
}

function fmtMinutes(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v < 60) return `${v.toFixed(1)}m`;
  const h = v / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function fmtMs(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v < 1) return `${(v * 1000).toFixed(0)}us`;
  if (v < 1000) return `${v.toFixed(0)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}
