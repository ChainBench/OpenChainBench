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
 * the bench specs (`mobula-monorepo/miniapps/pm-cohort-stats/`).
 *
 * Used by both the /prediction-markets hub leaderboard (for the venue
 * row link + chain badge) and the /products/<slug> page (to inject the
 * full PM venue dashboard when the slug matches a tracked venue).
 */

export const PM_VENUE_META: Record<string, { url: string; chainLabel: string }> = {
  polymarket: { url: "https://polymarket.com", chainLabel: "Polygon" },
  kalshi: { url: "https://kalshi.com", chainLabel: "Offchain US" },
  limitless: { url: "https://limitless.exchange", chainLabel: "Base" },
  myriad: { url: "https://myriad.markets", chainLabel: "Abstract L2" },
};

// Logo paths come from the central manifest (`src/lib/logo-manifest.ts`)
// so a slug whose file extension changes (e.g. predexon.svg → predexon.png)
// only needs the manifest edit, not a parallel update here. The previous
// shape hardcoded ".png" for slugs whose actual asset was ".svg" and the
// header in PmDataFeedSection rendered a broken-image glyph for codex,
// mobula, and predexon.
export const PM_FEED_META: Record<string, { url?: string }> = {
  "polymarket-clob": { url: "https://polymarket.com" },
  predexon: { url: "https://predexon.com" },
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
  const cohortSize = cohort.venues.length;
  return [
    {
      benchSlug: "pm-api-latency",
      label: "API latency",
      blurb: "Warm price endpoint, 24h p50 across 3 regions.",
      rank: rankWithinCohort(cohort.venues, "p50ApiLatencyMs", venue.slug),
      cohortSize,
      value: fmtMs(venue.p50ApiLatencyMs),
      vsMedian: null,
      tone: "teal",
    },
    {
      benchSlug: "polymarket-resolution-delay",
      label: "Resolution delay",
      blurb: "ProposePrice anchor to QuestionResolved block, median.",
      rank: rankWithinCohort(cohort.venues, "medianResolutionDelayMin", venue.slug),
      cohortSize,
      value: fmtMinutes(venue.medianResolutionDelayMin),
      vsMedian: null,
      tone: "cyan",
    },
    {
      benchSlug: "pm-ws-latency",
      label: "WS latency",
      blurb: "Connect-to-snapshot and trade publication lag on the venue WebSocket.",
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

function rankWithinCohort(
  venues: PmVenueRow[],
  key: "p50ApiLatencyMs" | "medianResolutionDelayMin",
  slug: string,
): number | null {
  const populated = venues
    .map((r) => ({ slug: r.slug, v: r[key] }))
    .filter((r) => r.v != null && Number.isFinite(r.v as number));
  if (populated.length === 0) return null;
  populated.sort((a, b) => (a.v as number) - (b.v as number));
  const idx = populated.findIndex((r) => r.slug === slug);
  return idx >= 0 ? idx + 1 : null;
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
