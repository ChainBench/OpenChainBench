/**
 * Server-side helper for the /perps hub page. Reads the `perp_venue_*`
 * gauges exposed by the cross-venue perp cohort harness, plus a handful
 * of cross-bench gauges already in prod:
 *   - perp_fees_all_in_bps{venue, asset}      (bench perp-fees, № 007)
 *   - perp_funding_hold_24h_bps{venue, asset} (bench perp-funding, № 036)
 *
 * The harness publishes one series per venue. Slugs that the harness
 * does not cover yet still render in the leaderboard with every numeric
 * field nulled, so the page degrades gracefully before the cohort
 * harness goes live.
 *
 * Shape mirrors `pm-stats.ts` exactly so the hub composes the same way
 * as /prediction-markets: one server fetch, one client tab swap.
 */

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
      `avg_over_time(perp_fees_all_in_bps{asset="ETH"}[24h])`,
    ),
    // 24h average of the perp-funding bench (036), ETH only.
    queryVector(
      prom,
      `avg_over_time(perp_funding_hold_24h_bps{asset="ETH"}[24h])`,
    ),
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
