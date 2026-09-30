/**
 * Compare pages, head to head data surfaces for two providers that
 * compete in the same OpenChainBench benchmark(s).
 *
 * URL pattern, /compare/<a>-vs-<b>, with the two slugs in alphabetical
 * order so each pair has exactly one canonical URL. The slug field is
 * the source of truth, the page route validates it matches the
 * `providerA-vs-providerB` shape and resolves both providers from the
 * existing provider registry.
 *
 * **Bench selection: auto by default, override only when needed.**
 *
 * The compare page route computes the natural intersection of both
 * providers' bench appearances at render time, so an entry like
 * `{ slug: "arbitrum-vs-base", providerA: "arbitrum", providerB: "base", publishedAt: "..." }`
 * surfaces every bench where both providers appear, with zero manual
 * curation. Adding a new bench that includes both providers lights up
 * on the existing pair page automatically on the next ISR window.
 *
 * Two optional overrides:
 *   - `benchmarks`: whitelist. Use only when editorial focus demands
 *     featuring a strict subset of the natural intersection.
 *   - `excludeBenchmarks`: blacklist. Use when one specific shared
 *     bench is noisy or off-topic for this pair (e.g. a draft bench
 *     surfacing zero p50). Preferred over `benchmarks` because it keeps
 *     the page in sync as new shared benches land.
 *
 * Pair selection criteria (mirrors the public methodology copy):
 *
 *  1. Both providers run in the same OpenChainBench benchmark for at
 *     least seven consecutive days at the time of inclusion.
 *  2. Each provider has at least 1000 samples in the measurement window.
 *  3. The head to head query has observable third party search demand
 *     (verified via public keyword tools, soft threshold 100 searches
 *     per month).
 *  4. Both providers have a public `/products/<slug>` page on OCB.
 *
 * Pairs are de published if any provider's harness goes offline for
 * more than 48 hours or if sample count drops below threshold. This
 * file is the versioned ledger of every pair that has met the criteria
 * so the methodology is externally verifiable.
 */

export type ComparePair = {
  /** Alphabetical slug, `<providerA>-vs-<providerB>`. Canonical. */
  slug: string;
  /** Provider slug, alphabetically first. */
  providerA: string;
  /** Provider slug, alphabetically second. */
  providerB: string;
  /**
   * Optional editorial whitelist of which benches to feature. When
   * omitted (the common case), the page renders every bench where both
   * providers naturally appear. Set this only when the natural
   * intersection contains benches we want to actively hide; prefer
   * `excludeBenchmarks` over this whitelist whenever possible because
   * it keeps the page in sync as new shared benches land.
   */
  benchmarks?: string[];
  /**
   * Optional blacklist applied on top of the natural intersection.
   * Use when a specific shared bench is noisy or off topic for this
   * pair (e.g. a draft bench whose p50 sits at zero for both providers).
   */
  excludeBenchmarks?: string[];
  /** ISO date the pair first cleared the gating criteria. */
  publishedAt: string;
  /**
   * Optional hero module rendered above the shared bench cards.
   * `perp-volume` puts bench 266's daily perp volume head to head
   * (closed UTC days, backfilled) at the top: the number flip claims
   * between two perp venues are made on. Both providers must be venues
   * of the perp-volume-history cohort; the module hides itself
   * otherwise.
   */
  hero?: "perp-volume";
};

export const COMPARE_PAIRS: ComparePair[] = [
  {
    slug: "arbitrum-vs-base",
    providerA: "arbitrum",
    providerB: "base",
    publishedAt: "2026-06-17",
  },
  {
    slug: "arbitrum-vs-optimism",
    providerA: "arbitrum",
    providerB: "optimism",
    publishedAt: "2026-06-09",
  },
  {
    slug: "arbitrum-vs-zksync",
    providerA: "arbitrum",
    providerB: "zksync",
    publishedAt: "2026-06-17",
  },
  {
    slug: "axiom-vs-phantom-perps",
    providerA: "axiom",
    providerB: "phantom-perps",
    publishedAt: "2026-06-17",
  },
  // 36 of the site's 289 clicks over the 2026-06/09 Search Console window
  // ('invo vs fomo' at position 1.6). Both sit on one daily-cut bench and
  // a quiet day for either flipped the ad hoc page to noindex for an hour
  // (Hyperliquid audit 2026-09-24); curated pairs skip that gate.
  {
    slug: "fomo-vs-invo",
    providerA: "fomo",
    providerB: "invo",
    publishedAt: "2026-09-24",
  },
  {
    slug: "base-vs-optimism",
    providerA: "base",
    providerB: "optimism",
    publishedAt: "2026-06-17",
  },
  {
    slug: "base-vs-zksync",
    providerA: "base",
    providerB: "zksync",
    publishedAt: "2026-06-17",
  },
  // chainlink-vs-pyth removed from v1. The oracle-deviation bench
  // ranks USD pairs (BTC/USD, ETH/USD…) rather than oracle providers,
  // so the natural intersection returns an empty set and the page would
  // 404. Reintroduce once a per-source oracle bench lands (or we
  // change oracle-deviation to surface providers as rows).
  {
    slug: "codex-vs-geckoterminal",
    providerA: "codex",
    providerB: "geckoterminal",
    publishedAt: "2026-06-17",
  },
  {
    slug: "dai-vs-usdc",
    providerA: "dai",
    providerB: "usdc",
    publishedAt: "2026-06-17",
  },
  {
    slug: "debridge-vs-relay",
    providerA: "debridge",
    providerB: "relay",
    publishedAt: "2026-06-09",
  },
  {
    slug: "dydx-vs-hyperliquid",
    providerA: "dydx",
    providerB: "hyperliquid",
    publishedAt: "2026-06-17",
    hero: "perp-volume",
  },
  {
    slug: "ethereum-vs-solana",
    providerA: "ethereum",
    providerB: "solana",
    publishedAt: "2026-06-17",
  },
  {
    slug: "fomo-vs-pump-fun",
    providerA: "fomo",
    providerB: "pump-fun",
    publishedAt: "2026-08-12",
  },
  {
    slug: "gains-vs-gmx",
    providerA: "gains",
    providerB: "gmx",
    publishedAt: "2026-09-14",
    hero: "perp-volume",
  },
  {
    slug: "aster-vs-hyperliquid",
    providerA: "aster",
    providerB: "hyperliquid",
    publishedAt: "2026-09-15",
    hero: "perp-volume",
  },
  {
    slug: "aster-vs-lighter",
    providerA: "aster",
    providerB: "lighter",
    publishedAt: "2026-09-15",
    hero: "perp-volume",
  },
  {
    slug: "dydx-vs-gmx",
    providerA: "dydx",
    providerB: "gmx",
    publishedAt: "2026-09-15",
    hero: "perp-volume",
  },
  {
    slug: "gmx-vs-hyperliquid",
    providerA: "gmx",
    providerB: "hyperliquid",
    publishedAt: "2026-06-17",
    hero: "perp-volume",
  },
  {
    slug: "hyperliquid-vs-lighter",
    providerA: "hyperliquid",
    providerB: "lighter",
    publishedAt: "2026-06-17",
    hero: "perp-volume",
  },
  // Phase 4 (2026-09-23): the regulated book against the largest DEX, the
  // HIP-3 deployer against its host, and the two US-facing venues that
  // run both prediction markets and perps.
  {
    slug: "hyperliquid-vs-kalshi",
    providerA: "hyperliquid",
    providerB: "kalshi",
    publishedAt: "2026-09-23",
  },
  {
    slug: "hyperliquid-vs-xyz",
    providerA: "hyperliquid",
    providerB: "xyz",
    publishedAt: "2026-09-23",
  },
  {
    slug: "kalshi-vs-polymarket",
    providerA: "kalshi",
    providerB: "polymarket",
    publishedAt: "2026-09-23",
  },
  {
    slug: "jupiter-vs-mobula",
    providerA: "jupiter",
    providerB: "mobula",
    publishedAt: "2026-06-17",
  },
  // Removed 2026-07-05: raydium has zero bench appearances so the compare
  // page 404s on hasSharedBenches. Re-add when raydium is measured in any
  // OCB benchmark (Solana DEX aggregator or similar).
  // { slug: "jupiter-vs-raydium", providerA: "jupiter", providerB: "raydium", publishedAt: "2026-06-17" },
  {
    slug: "lifi-vs-mobula",
    providerA: "lifi",
    providerB: "mobula",
    publishedAt: "2026-06-17",
  },
  {
    slug: "mobula-vs-relay",
    providerA: "mobula",
    providerB: "relay",
    publishedAt: "2026-06-17",
  },
  {
    slug: "solana-vs-sui",
    providerA: "solana",
    providerB: "sui",
    publishedAt: "2026-06-09",
  },
  {
    slug: "usdc-vs-usdt",
    providerA: "usdc",
    providerB: "usdt",
    publishedAt: "2026-06-17",
  },
];

export function getComparePair(slug: string): ComparePair | undefined {
  return COMPARE_PAIRS.find((p) => p.slug === slug);
}

export function getComparePairSlugs(): string[] {
  return COMPARE_PAIRS.map((p) => p.slug);
}
