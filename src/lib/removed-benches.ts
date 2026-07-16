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
  // indexer-latency (084) dropped entirely 2026-07-16: HyperSync + The
  // Graph providers require paid credentials for the sustained cadence
  // (Mobula alone left the leaderboard single-provider). Spec + harness
  // removed; kept in the 410 list so any indexed URL returns Gone
  // instead of 404.
  "indexer-latency",
  // oracle-freshness (082) spec dropped 2026-07-16: apples vs oranges
  // (push oracle Chainlink vs pull oracles Pyth/RedStone measure
  // different things; splitting into 2 sub-benches would leave each
  // with 1-2 providers). Redundant with 025 oracle-deviation which
  // measures the same feeds via CEX deviation, more actionable signal.
  // Harness code retained in oracle-deviation (metrics still emit, no
  // reader on the site).
  "oracle-freshness",
  // staging pipeline, held back until validated / announced
  "indexing-freshness",
  "rpc-keyed-latency",
  "explorer-chain-coverage",
  "portfolio-chain-coverage",
]);
