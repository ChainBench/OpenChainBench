import {
  fetchPerpCohort,
  type PerpCohortSummary,
  type PerpVenueRow,
  type PerpVenueType,
} from "@/lib/perp-stats";
import type { Benchmark } from "@/types/benchmark";
import type { PerpVenueBenchRow } from "@/components/perp-venue-bench-cards";

/**
 * Per-venue metadata for the perps cohort. Hardcoded because the venue
 * set is small, curated, and shared with the bench specs (perp-fees and
 * perp-funding live in `benchmarks/`, the cohort harness lives in the
 * private upstream-api miniapps tree).
 *
 * Used by the /perps hub leaderboard (chain badge, external link) and
 * by /products/<slug> to inject the perp venue dashboard when the slug
 * matches a tracked venue.
 *
 * The product-page slug for some venues differs from the cohort slug:
 *  - cohort "gmx-v2" maps to product slug "gmx" (entry in PROVIDER_REGISTRY)
 * Other slugs (hyperliquid, lighter, dydx, paradex, aster) match 1:1.
 */

export const PERP_VENUE_META: Record<
  string,
  { url: string; chainLabel: string; productSlug?: string }
> = {
  hyperliquid: { url: "https://hyperliquid.xyz", chainLabel: "Hyperliquid L1" },
  lighter:     { url: "https://lighter.xyz",     chainLabel: "Lighter L2" },
  "gmx-v2":    { url: "https://gmx.io",          chainLabel: "Arbitrum", productSlug: "gmx" },
  gains:       { url: "https://gains.trade",     chainLabel: "Arbitrum, Base, Polygon, ApeChain" },
  dydx:        { url: "https://dydx.trade",      chainLabel: "Cosmos" },
  nado:        { url: "https://nado.xyz",        chainLabel: "Ink" },
  paradex:     { url: "https://paradex.trade",   chainLabel: "Starknet" },
  aster:       { url: "https://asterdex.com",    chainLabel: "BNB Chain" },
  edgex:       { url: "https://pro.edgex.exchange", chainLabel: "zkSync" },
  extended:    { url: "https://extended.exchange",  chainLabel: "Starknet" },
  aevo:        { url: "https://aevo.xyz",        chainLabel: "OP Stack" },
  pacifica:    { url: "https://pacifica.fi",     chainLabel: "Solana" },
  ostium:      { url: "https://ostium.app",      chainLabel: "Arbitrum" },
  grvt:        { url: "https://grvt.io",         chainLabel: "zkSync" },
  polymarket:  { url: "https://polymarket.com",  chainLabel: "Polygon" },
  synfutures:  { url: "https://synfutures.com",  chainLabel: "Base, Arbitrum" },
  kiloex:      { url: "https://kiloex.io",       chainLabel: "BSC, Base, opBNB" },
  orderly:     { url: "https://orderly.network", chainLabel: "Multi-chain" },
  backpack:    { url: "https://backpack.exchange", chainLabel: "Solana" },
  kalshi:      { url: "https://kalshi.com/perpetuals", chainLabel: "US, CFTC DCM" },
  vest:        { url: "https://vest.exchange",   chainLabel: "Vest zk appchain" },
  standx:      { url: "https://standx.com",      chainLabel: "BNB Chain" },
  apex:        { url: "https://omni.apex.exchange", chainLabel: "Omnichain" },
  jupiter:     { url: "https://jup.ag/perps",    chainLabel: "Solana" },
  "lighter-rh": { url: "https://rh.lighter.xyz", chainLabel: "Lighter L2, Robinhood" },
  "trade-xyz": { url: "https://trade.xyz",       chainLabel: "Hyperliquid HIP-3", productSlug: "xyz" },
  binance:     { url: "https://www.binance.com/en/futures", chainLabel: "Offchain, CEX" },
  okx:         { url: "https://www.okx.com/trade-swap", chainLabel: "Offchain, CEX" },
  bybit:       { url: "https://www.bybit.com/trade/usdt", chainLabel: "Offchain, CEX" },
  gate:        { url: "https://www.gate.com/futures", chainLabel: "Offchain, CEX" },
  coinbase:    { url: "https://international.coinbase.com", chainLabel: "Offchain, CEX" },
  bitget:      { url: "https://www.bitget.com/futures", chainLabel: "Offchain, CEX" },
  deribit:     { url: "https://www.deribit.com",  chainLabel: "Offchain, CEX" },
  kraken:      { url: "https://futures.kraken.com", chainLabel: "Offchain, CEX" },
  kucoin:      { url: "https://www.kucoin.com/futures", chainLabel: "Offchain, CEX" },
  mexc:        { url: "https://futures.mexc.com", chainLabel: "Offchain, CEX" },
};

/**
 * Slugs that surface the /perps pill on the product header (mirrors
 * the /prediction-markets pattern). All cohort venues plus the GMX
 * product slug, which the cohort tracks under gmx-v2.
 */
export const PERP_PRODUCT_PILL_SLUGS: ReadonlySet<string> = new Set([
  ...Object.keys(PERP_VENUE_META),
  // PROVIDER_REGISTRY entries whose cohort key differs (gmx for gmx-v2,
  // xyz for trade-xyz).
  ...Object.values(PERP_VENUE_META).flatMap((m) => (m.productSlug ? [m.productSlug] : [])),
]);

/** Cohort key for a product slug: the key itself, or the key whose
 *  productSlug names it (gmx -> gmx-v2, xyz -> trade-xyz). */
export function perpCohortSlugForProduct(slug: string): string | null {
  if (PERP_VENUE_META[slug]) return slug;
  for (const [key, meta] of Object.entries(PERP_VENUE_META)) {
    if (meta.productSlug === slug) return key;
  }
  return null;
}

export type PerpVenueContext = {
  kind: "venue";
  slug: string;
  cohortSlug: string;
  name: string;
  chainLabel: string;
  externalUrl: string;
  venueType: PerpVenueType;
  benchRows: PerpVenueBenchRow[];
};

/**
 * Resolve a provider slug to a perp venue context, or null if the
 * slug is not in the cohort. Caller (product page) reuses the same
 * fetchPerpCohort cache the hub warms.
 */
export async function getPerpVenueContext(
  slug: string,
  feesAtSizeBench?: Benchmark | null,
): Promise<PerpVenueContext | null> {
  // Map product slug to cohort slug for the few that differ (gmx ->
  // gmx-v2, xyz -> trade-xyz); everything else lines up 1:1.
  const cohortSlug = perpCohortSlugForProduct(slug);
  if (!cohortSlug) return null;

  const meta = PERP_VENUE_META[cohortSlug];
  if (!meta) return null;

  const cohort = await fetchPerpCohort();
  if (!cohort) return null;

  const venue = cohort.venues.find((v) => v.slug === cohortSlug);
  if (!venue) return null;

  return {
    kind: "venue",
    slug,
    cohortSlug,
    name: venue.name,
    chainLabel: meta.chainLabel,
    externalUrl: meta.url,
    venueType: venue.venueType,
    benchRows: benchRowsForVenue(cohort, venue, feesAtSizeBench ?? null),
  };
}

export function benchRowsForVenue(
  cohort: PerpCohortSummary,
  venue: PerpVenueRow,
  feesAtSizeBench?: Benchmark | null,
): PerpVenueBenchRow[] {
  // Measured venues only: the CEX reference rows (venue-reported via
  // CoinGecko, funding from Mobula) sit behind the hub selector and are
  // on no bench, so they rank nothing here either. Without this, Binance's
  // pair count outranked every DEX on the Active markets card while the
  // card linked to a bench that lists no CEX.
  const measured = cohort.venues.filter((v) => v.venueType !== "cex");
  const cohortSize = measured.length;

  const activeMarketsVenues = measured
    .filter((v) => v.activeMarkets != null && Number.isFinite(v.activeMarkets))
    .sort((a, b) => (b.activeMarkets as number) - (a.activeMarkets as number));
  const activeMarketsRank =
    activeMarketsVenues.findIndex((v) => v.slug === venue.slug) + 1 || null;

  const feesAtSize = feesAtSizeBench
    ? rankFromBench(feesAtSizeBench, venue.slug)
    : null;

  return [
    {
      benchSlug: "perp-fees",
      label: "All-in fee (ETH 10x)",
      blurb:
        "Taker fee plus half-spread plus impact on a $1000 ETH 10x long, 24h average.",
      rank: rankWithinCohort(measured, "allInFeeBpsEth", venue.slug),
      cohortSize,
      value: fmtBps(venue.allInFeeBpsEth),
      vsMedian: null,
      tone: "teal",
    },
    {
      benchSlug: "perp-funding",
      label: "Funding cost (ETH 24h)",
      blurb:
        "Normalized funding cost to hold an ETH long for 24 hours, 24h average. Negative means longs get paid.",
      rank: rankWithinCohort(measured, "funding24hBpsEth", venue.slug),
      cohortSize,
      value: fmtBpsSigned(venue.funding24hBpsEth),
      vsMedian: null,
      tone: "cyan",
    },
    {
      benchSlug: "perp-active-markets",
      label: "Active markets",
      blurb:
        "Live count of active perp markets across 14 venues, polled every 5 minutes.",
      rank: activeMarketsRank,
      cohortSize: activeMarketsVenues.length || cohortSize,
      value:
        venue.activeMarkets != null
          ? Math.round(venue.activeMarkets).toLocaleString("en-US")
          : null,
      vsMedian: null,
      tone: "indigo",
    },
    {
      benchSlug: "perp-fees-at-size",
      label: "Fee at $100k",
      blurb:
        "All-in cost at $100k notional (taker + spread + impact), 24h average. Oracle venues hold flat regardless of size.",
      rank: feesAtSize?.rank ?? null,
      cohortSize: feesAtSize?.total ?? cohortSize,
      value: feesAtSize?.value != null ? fmtBps(feesAtSize.value) : null,
      vsMedian: null,
      tone: "violet",
    },
  ];
}

function rankWithinCohort(
  venues: PerpVenueRow[],
  key: "allInFeeBpsEth" | "funding24hBpsEth",
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

function rankFromBench(
  bench: Benchmark,
  slug: string,
): { rank: number | null; total: number; value: number | null } {
  const live = bench.results.filter(
    (r) => r.ms?.p50 != null && Number.isFinite(r.ms.p50),
  );
  const sorted = [...live].sort((a, b) =>
    bench.higherIsBetter ? b.ms.p50 - a.ms.p50 : a.ms.p50 - b.ms.p50,
  );
  const idx = sorted.findIndex((r) => r.slug === slug);
  const provider = bench.results.find((r) => r.slug === slug);
  return {
    rank: idx >= 0 ? idx + 1 : null,
    total: sorted.length,
    value: provider?.ms?.p50 ?? null,
  };
}

function fmtBps(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (Math.abs(v) >= 100) return `${v.toFixed(0)} bps`;
  return `${v.toFixed(1)} bps`;
}

function fmtBpsSigned(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  const sign = v > 0 ? "+" : "";
  if (Math.abs(v) >= 100) return `${sign}${v.toFixed(0)} bps`;
  return `${sign}${v.toFixed(1)} bps`;
}
