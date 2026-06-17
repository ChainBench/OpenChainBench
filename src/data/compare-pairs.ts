/**
 * Compare pages, head-to-head data surfaces for two providers that
 * compete in the same OpenChainBench benchmark(s).
 *
 * URL pattern, /compare/<a>-vs-<b>, with the two slugs in alphabetical
 * order so each pair has exactly one canonical URL. The slug field is
 * the source of truth, the page route validates it matches the
 * `providerA-vs-providerB` shape and resolves both providers from the
 * existing provider registry.
 *
 * Pair selection criteria (mirrors the public methodology copy):
 *
 *  1. Both providers run in the same OpenChainBench benchmark for ≥7
 *     consecutive days at the time of inclusion.
 *  2. Each provider has at least 1000 samples in the measurement window.
 *  3. The head-to-head query has observable third-party search demand
 *     (verified via public keyword tools, soft threshold 100 searches
 *     per month).
 *  4. Both providers have a public `/products/<slug>` page on OCB.
 *
 * Pairs are de-published if any provider's harness goes offline for
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
   * Optional pin of which benches to feature on the page. When omitted
   * the page renders every bench where both providers appear. Set this
   * when the intersection has noisy benches we do not want to surface.
   */
  benchmarks?: string[];
  /** ISO date the pair first cleared the gating criteria. */
  publishedAt: string;
};

export const COMPARE_PAIRS: ComparePair[] = [
  {
    slug: "arbitrum-vs-base",
    providerA: "arbitrum",
    providerB: "base",
    benchmarks: ["l2-block-time"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "arbitrum-vs-optimism",
    providerA: "arbitrum",
    providerB: "optimism",
    benchmarks: ["l2-block-time"],
    publishedAt: "2026-06-09",
  },
  {
    slug: "arbitrum-vs-zksync",
    providerA: "arbitrum",
    providerB: "zksync",
    benchmarks: ["l2-block-time"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "axiom-vs-phantom-perps",
    providerA: "axiom",
    providerB: "phantom-perps",
    benchmarks: ["hyperliquid-frontends"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "base-vs-optimism",
    providerA: "base",
    providerB: "optimism",
    benchmarks: ["l2-block-time"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "base-vs-zksync",
    providerA: "base",
    providerB: "zksync",
    benchmarks: ["l2-block-time"],
    publishedAt: "2026-06-17",
  },
  // chainlink-vs-pyth removed from v1. The oracle-deviation bench
  // ranks USD pairs (BTC/USD, ETH/USD…) rather than oracle providers,
  // so the intersection logic returns an empty set and the page would
  // 404. Reintroduce once a per-source oracle bench lands (or we
  // change oracle-deviation to surface providers as rows).
  {
    // metadata-coverage intentionally omitted: geckoterminal is not in
    // that bench's provider set, so pinning it would render an empty
    // panel on the compare page. Keeping aggregator-head-lag and
    // network-coverage where both providers compete head to head.
    slug: "codex-vs-geckoterminal",
    providerA: "codex",
    providerB: "geckoterminal",
    benchmarks: ["aggregator-head-lag", "network-coverage"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "codex-vs-mobula",
    providerA: "codex",
    providerB: "mobula",
    benchmarks: [
      "aggregator-head-lag",
      "metadata-coverage",
      "network-coverage",
    ],
    publishedAt: "2026-06-09",
  },
  {
    slug: "dai-vs-usdc",
    providerA: "dai",
    providerB: "usdc",
    benchmarks: ["stablecoin-peg"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "debridge-vs-relay",
    providerA: "debridge",
    providerB: "relay",
    benchmarks: ["bridge-fee", "bridge-quote-latency"],
    publishedAt: "2026-06-09",
  },
  {
    slug: "dydx-vs-hyperliquid",
    providerA: "dydx",
    providerB: "hyperliquid",
    benchmarks: ["perp-fees", "perp-funding"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "ethereum-vs-solana",
    providerA: "ethereum",
    providerB: "solana",
    benchmarks: ["l1-finality"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "gmx-vs-hyperliquid",
    providerA: "gmx",
    providerB: "hyperliquid",
    benchmarks: ["perp-fees"],
    publishedAt: "2026-06-17",
  },
  {
    // solana-tx-landing-latency exposes the Helius RPC sender under the
    // slug `helius-sender`, not bare `helius`, so the pair canonical
    // slug uses helius-sender to match the bench provider id.
    slug: "helius-sender-vs-jito",
    providerA: "helius-sender",
    providerB: "jito",
    benchmarks: ["solana-tx-landing-latency"],
    publishedAt: "2026-06-09",
  },
  {
    slug: "hyperliquid-vs-lighter",
    providerA: "hyperliquid",
    providerB: "lighter",
    benchmarks: ["perp-fees"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "jupiter-vs-mobula",
    providerA: "jupiter",
    providerB: "mobula",
    benchmarks: ["solana-dex-quote-latency"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "jupiter-vs-raydium",
    providerA: "jupiter",
    providerB: "raydium",
    benchmarks: ["solana-dex-quote-latency"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "lifi-vs-mobula",
    providerA: "lifi",
    providerB: "mobula",
    benchmarks: ["bridge-fee", "bridge-quote-latency"],
    publishedAt: "2026-06-17",
  },
  {
    // High-value data API triangulation. Both providers compete in
    // aggregator-head-lag and network-coverage; metadata-coverage is
    // omitted because geckoterminal is not measured there.
    slug: "geckoterminal-vs-mobula",
    providerA: "geckoterminal",
    providerB: "mobula",
    benchmarks: ["aggregator-head-lag", "network-coverage"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "mobula-vs-relay",
    providerA: "mobula",
    providerB: "relay",
    benchmarks: ["bridge-fee", "bridge-quote-latency"],
    publishedAt: "2026-06-17",
  },
  {
    slug: "solana-vs-sui",
    providerA: "solana",
    providerB: "sui",
    benchmarks: ["l1-finality"],
    publishedAt: "2026-06-09",
  },
  {
    slug: "usdc-vs-usdt",
    providerA: "usdc",
    providerB: "usdt",
    benchmarks: ["stablecoin-peg"],
    publishedAt: "2026-06-17",
  },
];

export function getComparePair(slug: string): ComparePair | undefined {
  return COMPARE_PAIRS.find((p) => p.slug === slug);
}

export function getComparePairSlugs(): string[] {
  return COMPARE_PAIRS.map((p) => p.slug);
}
