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
    slug: "arbitrum-vs-optimism",
    providerA: "arbitrum",
    providerB: "optimism",
    benchmarks: ["l2-block-time"],
    publishedAt: "2026-06-09",
  },
  {
    slug: "chainlink-vs-pyth",
    providerA: "chainlink",
    providerB: "pyth",
    benchmarks: ["oracle-deviation"],
    publishedAt: "2026-06-09",
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
    slug: "debridge-vs-relay",
    providerA: "debridge",
    providerB: "relay",
    benchmarks: ["bridge-fee", "bridge-quote-latency"],
    publishedAt: "2026-06-09",
  },
  {
    slug: "helius-vs-jito",
    providerA: "helius",
    providerB: "jito",
    benchmarks: ["solana-tx-landing-latency"],
    publishedAt: "2026-06-09",
  },
  {
    slug: "solana-vs-sui",
    providerA: "solana",
    providerB: "sui",
    benchmarks: ["l1-finality"],
    publishedAt: "2026-06-09",
  },
];

export function getComparePair(slug: string): ComparePair | undefined {
  return COMPARE_PAIRS.find((p) => p.slug === slug);
}

export function getComparePairSlugs(): string[] {
  return COMPARE_PAIRS.map((p) => p.slug);
}
