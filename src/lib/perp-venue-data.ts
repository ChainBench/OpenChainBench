/**
 * Per-venue KPI fetcher for the /perps hub. Hits `perp_venue_*` gauges
 * via `{venue="<slug>"}` selector for the 6-card strip and the bench
 * cards row. Cached for 2 minutes via unstable_cache, same pattern as
 * pm-venue-data.ts.
 *
 * The 90d volume + OI history is NOT on the harness today (a daily
 * Upstash snapshot job is the plan, same shape as PM). Until that
 * lands, the chart component on PerpVenueSection stays hidden.
 */

import { unstable_cache } from "next/cache";
import { Prometheus } from "@/lib/prometheus";

export type PerpVenueKpis = {
  /** USD 24h traded volume. */
  volume24h: number | null;
  /** USD 30d traded volume. */
  volume30d: number | null;
  /** USD outstanding open interest. */
  openInterest: number | null;
  /** USD 30d cumulative fees. */
  fees30d: number | null;
  /** Number of tradable markets right now. */
  activeMarkets: number | null;
  /** Top market 24h volume (USD). */
  topMarketVolume24h: number | null;
  /** Venue health (0..1). */
  health: number | null;
  /** All-in cost in bps to open a $1000 ETH 10x long (perp-fees bench). */
  allInFeeBpsEth: number | null;
  /** Funding cost in bps to hold a $1000 ETH long 24h (perp-funding bench). */
  funding24hBpsEth: number | null;
};

function promUrl(): string | null {
  return process.env.PROMETHEUS_URL?.trim() || null;
}

/**
 * The harness publishes the all-in-fee gauge for GMX under
 * venue="gmx" rather than "gmx-v2". When the hub asks for the gmx-v2
 * venue, we have to ask Prom for the gmx label. All other slugs match
 * the cohort harness 1:1.
 */
function perpFeesLabel(slug: string): string {
  return slug === "gmx-v2" ? "gmx" : slug;
}

async function fetchPerpVenueKpisRaw(
  slug: string,
): Promise<PerpVenueKpis | null> {
  const url = promUrl();
  if (!url) return null;
  let prom: Prometheus;
  try {
    prom = new Prometheus(url);
  } catch {
    return null;
  }
  const sel = `{venue="${slug}"}`;
  const feesSel = `{venue="${perpFeesLabel(slug)}",asset="ETH"}`;

  const [
    volume24h,
    volume30d,
    openInterest,
    fees30d,
    activeMarkets,
    topMarketVolume24h,
    health,
    allInFeeBpsEth,
    funding24hBpsEth,
  ] = await Promise.all([
    prom.scalar(`perp_venue_volume_24h_usd${sel}`),
    prom.scalar(`perp_venue_volume_30d_usd${sel}`),
    prom.scalar(`perp_venue_oi_usd${sel}`),
    prom.scalar(`perp_venue_fees_30d_usd${sel}`),
    prom.scalar(`perp_venue_active_markets${sel}`),
    prom.scalar(`perp_venue_top_market_volume_24h_usd${sel}`),
    prom.scalar(`perp_venue_health${sel}`),
    prom.scalar(`avg_over_time(perp_fees_all_in_bps${feesSel}[24h])`),
    prom.scalar(`avg_over_time(perp_funding_hold_24h_bps${feesSel}[24h])`),
  ]);

  // If every probe returned null assume the venue is not wired yet.
  if (
    volume24h === null &&
    volume30d === null &&
    openInterest === null &&
    fees30d === null &&
    activeMarkets === null &&
    health === null &&
    allInFeeBpsEth === null &&
    funding24hBpsEth === null
  ) {
    return null;
  }

  return {
    volume24h,
    volume30d,
    openInterest,
    fees30d,
    activeMarkets,
    topMarketVolume24h,
    health,
    allInFeeBpsEth,
    funding24hBpsEth,
  };
}

const fetchPerpVenueKpisCached = unstable_cache(
  fetchPerpVenueKpisRaw,
  ["perp-venue-kpis-v1"],
  { revalidate: 120, tags: ["perp-venue"] },
);

export async function fetchPerpVenueKpis(
  slug: string,
): Promise<PerpVenueKpis | null> {
  return fetchPerpVenueKpisCached(slug);
}
