/**
 * Server-side helper for the /perps hub page. Reads the `perp_venue_*`
 * gauges exposed by the cross-venue perp cohort harness, plus a handful
 * of cross-bench gauges already in prod:
 *   - perp_fees_all_in_bps{venue, asset}      (bench perp-fees, № 007)
 *   - perp_venue_funding_24h_bps{venue, asset}  (perp-cohort-stats harness, via Mobula funding aggregator, 12 venues)
 *   - perp_funding_hold_24h_bps{venue, asset}   (bench perp-funding № 036, 7 venues, kept as fallback)
 *
 * The harness publishes one series per venue. Slugs that the harness
 * does not cover yet still render in the leaderboard with every numeric
 * field nulled, so the page degrades gracefully before the cohort
 * harness goes live.
 *
 * Shape mirrors `pm-stats.ts` exactly so the hub composes the same way
 * as /prediction-markets: one server fetch, one client tab swap.
 */

import { unstable_cache } from "next/cache";
import { Prometheus } from "@/lib/prometheus";

export type PerpVenueType = "onchain";

export type PerpVenueRow = {
  slug: string;
  name: string;
  chain: string;
  venueType: PerpVenueType;
  volume24h: number | null;
  volume30d: number | null;
  openInterest: number | null;
  fees30d: number | null;
  activeMarkets: number | null;
  topMarketVolume24h: number | null;
  health: number | null;
  /** All-in bps to open a $1000 ETH 10x long (from perp-fees bench). */
  allInFeeBpsEth: number | null;
  /** Funding cost in bps to hold a $1000 ETH long 24h (from perp-funding bench). */
  funding24hBpsEth: number | null;
  /** Unix seconds of the harness's last successful refresh for this venue.
   *  Sourced from `perp_venue_last_refresh_unix` (max by venue). Null when
   *  the gauge is absent so the UI can hide the age badge gracefully. */
  lastRefreshUnix: number | null;
};

/**
 * One row per venue for the "By asset" tab. Per-asset funding columns
 * map to `perp_venue_funding_24h_bps{venue, asset}` and the fee column
 * stays on the perp-fees bench (only published for ETH today, hence the
 * single `feeEthBps` field). Any cell may be null when the harness has
 * not published that venue/asset pair yet; the table renders "-" in
 * that case.
 */
export type PerpAssetRow = {
  slug: string;
  name: string;
  fundingBtc: number | null;
  fundingEth: number | null;
  fundingSol: number | null;
  feeEthBps: number | null;
};

export type PerpCohortSummary = {
  venues: PerpVenueRow[];
  totals: {
    cohortVolume30d: number;
    cohortOpenInterest: number;
    trackedVenues: number;
    avgFunding24hEth: number | null;
  };
  asOf: number;
};

type VenueSeed = {
  slug: string;
  name: string;
  chain: string;
  venueType: PerpVenueType;
};

/**
 * Cohort seed. Order is the default leaderboard order before any
 * sort, and the slugs match the labels the harness publishes against
 * (`perp_venue_volume_24h_usd{venue="hyperliquid"}` etc.).
 */
export const PERP_VENUES: VenueSeed[] = [
  { slug: "hyperliquid", name: "Hyperliquid", chain: "Hyperliquid L1", venueType: "onchain" },
  { slug: "lighter",     name: "Lighter",     chain: "Lighter L2",    venueType: "onchain" },
  { slug: "gmx-v2",      name: "GMX v2",      chain: "Arbitrum",      venueType: "onchain" },
  { slug: "gains",       name: "Gains Network", chain: "Arbitrum",    venueType: "onchain" },
  { slug: "dydx",        name: "dYdX v4",     chain: "Cosmos",        venueType: "onchain" },
  { slug: "drift",       name: "Drift",       chain: "Solana",        venueType: "onchain" },
  { slug: "vertex",      name: "Vertex",      chain: "Arbitrum",      venueType: "onchain" },
  { slug: "paradex",     name: "Paradex",     chain: "Starknet",      venueType: "onchain" },
  { slug: "aster",       name: "Aster",       chain: "BNB Chain",     venueType: "onchain" },
  { slug: "edgex",       name: "EdgeX",       chain: "zkSync",        venueType: "onchain" },
  { slug: "extended",    name: "Extended",    chain: "Starknet",      venueType: "onchain" },
  { slug: "aevo",        name: "Aevo",        chain: "OP Stack",      venueType: "onchain" },
  { slug: "pacifica",    name: "Pacifica",    chain: "Solana",        venueType: "onchain" },
  { slug: "variational", name: "Variational", chain: "Arbitrum",      venueType: "onchain" },
  { slug: "ostium",      name: "Ostium",      chain: "Arbitrum",      venueType: "onchain" },
  { slug: "grvt",        name: "GRVT",        chain: "zkSync",        venueType: "onchain" },
];

function promUrl(): string | null {
  return process.env.PROMETHEUS_URL?.trim() || null;
}

/**
 * Fetch the cohort in one Promise.all fan out. Returns null when Prom
 * is unreachable so the page can render a configuration banner instead
 * of a blank leaderboard. A reachable Prom with no series yet (harness
 * not yet deployed) returns a fully populated shape with every numeric
 * field nulled; the leaderboard shows dashes and the page still ships.
 */
export async function fetchPerpCohort(): Promise<PerpCohortSummary | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }

  const [
    vol24h,
    vol30d,
    oi,
    fees30d,
    activeMarkets,
    topMarketVol24h,
    health,
    allInFeeEth,
    funding24hEth,
    lastRefresh,
  ] = await Promise.all([
    queryVector(prom, `perp_venue_volume_24h_usd`),
    queryVector(prom, `perp_venue_volume_30d_usd`),
    queryVector(prom, `perp_venue_oi_usd`),
    queryVector(prom, `perp_venue_fees_30d_usd`),
    queryVector(prom, `perp_venue_active_markets`),
    queryVector(prom, `perp_venue_top_market_volume_24h_usd`),
    queryVector(prom, `perp_venue_health`),
    // 24h average of the cross-venue all-in-fee bench (007), ETH only,
    // keyed by venue. Picks up Lighter, Hyperliquid, dYdX, GMX, gains.
    // The harness venue slug for GMX is "gmx" not "gmx-v2"; the row
    // mapping below aliases gmx → gmx-v2 so the bench number shows up
    // on the right leaderboard line.
    queryVector(
      prom,
      `avg_over_time(perp_fees_all_in_bps{chain="ETH"}[24h])`,
    ),
    // 24h average of the cross-venue funding feed (perp-cohort-stats
    // harness via Mobula), ETH only. Covers 12 venues. Falls back to
    // the perp-funding bench (036, 7 venues) via PromQL `or` so any
    // venue the harness has not picked up yet still surfaces a value.
    queryVector(
      prom,
      `avg_over_time(perp_venue_funding_24h_bps{asset="ETH"}[24h]) or avg_over_time(perp_funding_hold_24h_bps{asset="ETH"}[24h])`,
    ),
    // Latest harness-side refresh stamp per venue. `max by` collapses
    // any duplicate scraper instances so a venue with two scrape jobs
    // still surfaces a single freshness value. Used by the UI age badge
    // on /perps to flag Prom freeze or harness downtime per row.
    queryVector(prom, `max by (venue) (perp_venue_last_refresh_unix)`),
  ]);

  const byVenue = new Map<string, PerpVenueRow>();
  for (const v of PERP_VENUES) {
    byVenue.set(v.slug, {
      slug: v.slug,
      name: v.name,
      chain: v.chain,
      venueType: v.venueType,
      volume24h: null,
      volume30d: null,
      openInterest: null,
      fees30d: null,
      activeMarkets: null,
      topMarketVolume24h: null,
      health: null,
      allInFeeBpsEth: null,
      funding24hBpsEth: null,
      lastRefreshUnix: null,
    });
  }

  const apply = (
    series: { labels: Record<string, string>; value: number }[] | null,
    field: keyof Omit<PerpVenueRow, "slug" | "name" | "chain" | "venueType">,
  ) => {
    for (const s of series ?? []) {
      const v = s.labels.venue;
      if (!v) continue;
      const row = byVenue.get(v);
      if (!row) continue;
      row[field] = s.value;
    }
  };

  apply(vol24h, "volume24h");
  apply(vol30d, "volume30d");
  apply(oi, "openInterest");
  apply(fees30d, "fees30d");
  apply(activeMarkets, "activeMarkets");
  apply(topMarketVol24h, "topMarketVolume24h");
  apply(health, "health");

  // perp-fees publishes the GMX line as venue="gmx"; the leaderboard
  // row is keyed gmx-v2. Map both labels onto the gmx-v2 row so the
  // bench number lands in the right column.
  for (const s of allInFeeEth ?? []) {
    const venueLabel = s.labels.venue;
    if (!venueLabel) continue;
    const targetSlug = venueLabel === "gmx" ? "gmx-v2" : venueLabel;
    const row = byVenue.get(targetSlug);
    if (!row) continue;
    row.allInFeeBpsEth = s.value;
  }

  for (const s of funding24hEth ?? []) {
    const venueLabel = s.labels.venue;
    if (!venueLabel) continue;
    const targetSlug = venueLabel === "gmx" ? "gmx-v2" : venueLabel;
    const row = byVenue.get(targetSlug);
    if (!row) continue;
    row.funding24hBpsEth = s.value;
  }

  for (const s of lastRefresh ?? []) {
    const venueLabel = s.labels.venue;
    if (!venueLabel) continue;
    const targetSlug = venueLabel === "gmx" ? "gmx-v2" : venueLabel;
    const row = byVenue.get(targetSlug);
    if (!row) continue;
    row.lastRefreshUnix = s.value;
  }

  const venues = [...byVenue.values()];
  let cohortVolume30d = 0;
  let cohortOpenInterest = 0;
  let trackedVenues = 0;
  for (const r of venues) {
    if (r.volume30d != null) {
      cohortVolume30d += r.volume30d;
      trackedVenues += 1;
    }
    if (r.openInterest != null) cohortOpenInterest += r.openInterest;
  }
  const fundingValues = venues
    .map((r) => r.funding24hBpsEth)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const avgFunding24hEth = fundingValues.length
    ? fundingValues.reduce((s, v) => s + v, 0) / fundingValues.length
    : null;

  return {
    venues,
    totals: {
      cohortVolume30d,
      cohortOpenInterest,
      trackedVenues,
      avgFunding24hEth,
    },
    asOf: Math.floor(Date.now() / 1000),
  };
}

/**
 * Per-asset cross-venue funding matrix for the "By asset" tab on /perps.
 * Pivots the harness gauge `perp_venue_funding_24h_bps{venue, asset}`
 * into one row per venue with three funding columns (BTC, ETH, SOL)
 * plus the perp-fees all-in ETH column from bench 007.
 *
 * Returns [] (never null) when Prom is unreachable or empty so the tab
 * can render a "data warming up" placeholder without throwing. Wrapped
 * in `unstable_cache` (tag `perp-by-asset`, 120s revalidate) so the
 * three asset columns plus the fee column round-trip Prom at most once
 * every two minutes regardless of page traffic.
 */
async function fetchPerpByAssetMatrixRaw(): Promise<PerpAssetRow[]> {
  const url = promUrl();
  if (!url) return [];
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return [];
  }

  const [funding, feeEth] = await Promise.all([
    // 24h average of the cross-venue funding feed, all assets in one
    // shot. The harness publishes `{venue, asset}` so the pivot below
    // splits BTC, ETH and SOL into separate columns. Falls back to the
    // perp-funding bench (036) per venue/asset for cells the cohort
    // harness has not picked up yet.
    queryVector(
      prom,
      `avg_over_time(perp_venue_funding_24h_bps{asset=~"BTC|ETH|SOL"}[24h]) or avg_over_time(perp_funding_hold_24h_bps{asset=~"BTC|ETH|SOL"}[24h])`,
    ),
    // All-in fee column, ETH only (perp-fees publishes ETH today; BTC
    // and SOL are on the roadmap). Mirrors the cohort fetcher's
    // gmx → gmx-v2 alias treatment.
    queryVector(
      prom,
      `avg_over_time(perp_fees_all_in_bps{chain="ETH"}[24h])`,
    ),
  ]);

  const byVenue = new Map<string, PerpAssetRow>();
  for (const v of PERP_VENUES) {
    byVenue.set(v.slug, {
      slug: v.slug,
      name: v.name,
      fundingBtc: null,
      fundingEth: null,
      fundingSol: null,
      feeEthBps: null,
    });
  }

  for (const s of funding ?? []) {
    const venueLabel = s.labels.venue;
    const assetLabel = s.labels.asset;
    if (!venueLabel || !assetLabel) continue;
    const targetSlug = venueLabel === "gmx" ? "gmx-v2" : venueLabel;
    const row = byVenue.get(targetSlug);
    if (!row) continue;
    if (assetLabel === "BTC") row.fundingBtc = s.value;
    else if (assetLabel === "ETH") row.fundingEth = s.value;
    else if (assetLabel === "SOL") row.fundingSol = s.value;
  }

  for (const s of feeEth ?? []) {
    const venueLabel = s.labels.venue;
    if (!venueLabel) continue;
    const targetSlug = venueLabel === "gmx" ? "gmx-v2" : venueLabel;
    const row = byVenue.get(targetSlug);
    if (!row) continue;
    row.feeEthBps = s.value;
  }

  // Drop venues with no signal at all so the tab does not pad rows of
  // dashes for venues the harness has not picked up yet. The cohort
  // tab keeps the full list (it has chain + venueType to render even
  // empty); the by-asset tab is denser and benefits from omission.
  return [...byVenue.values()].filter(
    (r) =>
      r.fundingBtc != null ||
      r.fundingEth != null ||
      r.fundingSol != null ||
      r.feeEthBps != null,
  );
}

const fetchPerpByAssetMatrixCached = unstable_cache(
  fetchPerpByAssetMatrixRaw,
  ["perp-by-asset-matrix-v1"],
  { revalidate: 120, tags: ["perp-by-asset"] },
);

export async function fetchPerpByAssetMatrix(): Promise<PerpAssetRow[]> {
  return fetchPerpByAssetMatrixCached();
}

/**
 * Tiny vector helper mirroring pm-stats.ts. Kept local so this module
 * stays self contained; the broader Prometheus client only exposes
 * scalars.
 */
async function queryVector(
  prom: Prometheus,
  promql: string,
): Promise<{ labels: Record<string, string>; value: number }[] | null> {
  try {
    const res = await prom.query(promql);
    if (res.resultType !== "vector") return [];
    return res.result
      .map((r) => ({
        labels: r.metric,
        value: Number(r.value[1]),
      }))
      .filter((r) => Number.isFinite(r.value));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `prom.queryVector failed (${reason}) for query: ${promql.slice(0, 200)}`,
    );
    return null;
  }
}
