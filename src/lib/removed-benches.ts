/**
 * Bench slugs that must not exist on production. They render normally
 * on dev / staging / preview (VERCEL_ENV !== "production") and are the
 * staging pipeline: benches still being validated, or held back for a
 * partnership announcement.
 *
 * Enforced in three places, all driven by this single set:
 *  1. src/middleware.ts returns 410 Gone for direct URL hits on prod
 *     (SEO-correct signal for previously indexed URLs).
 *  2. src/lib/materialize/load.ts drops the specs at loader level on
 *     prod, so the catalog index, category pages, /rpc hub, compare
 *     pairs, /api/citable, llms.txt and RSS never link or cite them.
 *  3. src/app/sitemap.ts excludes the routes on prod.
 *
 * Moving a bench to production = remove its slug here, bump the
 * bench-set cache keys in src/lib/spec.ts, ship dev to main.
 */
/**
 * Answer pages (answers/<slug>.yml) whose referenced benchmark is in
 * REMOVED_BENCH_SLUGS. Same treatment: 410 on prod direct hits, dropped
 * from the answers listing and sitemap on prod, normal on staging.
 */
export const REMOVED_ANSWER_SLUGS = new Set([
  "which-evm-aggregator-has-the-fastest-quote",
  "which-solana-rpc-lands-the-most-transactions",
]);

export const REMOVED_BENCH_SLUGS = new Set([
  // retired for good
  "bridge-revenue",
  "evm-quote-latency",
  // duplicate of solana-tx-landing (bench 016); the 027 active-probe
  // variant never got data on prod and shows an empty placeholder
  "solana-tx-landing-latency",
  // staging pipeline, held back until validated / announced
  "indexing-freshness",
  "rpc-keyed-latency",
  "explorer-chain-coverage",
  "tokenized-stock-arb-latency",
  "portfolio-chain-coverage",
  // bench vague 2 (082-085): validating on staging until harnesses have
  // 48h of clean data on the VPS, then ship dev -> main. 081 renamed
  // to ws-head-latency-ethereum for slug parity with the base + solana
  // siblings; both siblings shipped to main without gating (harness has
  // clean data via Railway 3-region deploy), so the ethereum-scoped one
  // follows suit and is not gated.
  "oracle-freshness",
  "rpc-reliability",
  "indexer-latency",
  "evm-block-builders",
]);
