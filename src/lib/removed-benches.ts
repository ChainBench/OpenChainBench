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
 * Bench slugs renamed / split, mapped to their canonical successor.
 * Middleware issues a 301 (permanent) redirect on prod so external
 * backlinks and previously-indexed URLs keep their PageRank pointing
 * at the current page instead of hitting a 410 / 404.
 *
 * Enforced in src/middleware.ts BEFORE the REMOVED_BENCH_SLUGS check
 * so a slug listed here always wins the 301 over a 410. Only list a
 * slug here when the successor bench genuinely covers the same reader
 * intent — do not redirect to unrelated pages.
 */
export const RENAMED_BENCH_SLUGS: Record<string, string> = {
  // network-coverage split (2026-07-24) into 2 apple-to-apple benches:
  //   - asset-registry-coverage (which chains a data API knows tokens on)
  //   - dex-network-coverage    (which chains a data API indexes DEX pools on)
  // The original bench mixed the two definitions, flagged on Twitter by
  // @sooneggg after CoinPaprika #1 with 307 (asset registry via
  // /v1/contracts) landed next to GeckoTerminal 265 (DEX indexing via
  // /networks). CoinPaprika's #1 claim reflects the asset-registry
  // framing, so 301 the legacy URL there; DEX-only readers reach the
  // dex-network-coverage bench via the cross-link at the top of the
  // successor page.
  "network-coverage": "asset-registry-coverage",
};

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
  // tokenized-stock-arb-latency (080) dropped 2026-07-16 after ship-
  // then-revert: Robinhood Chain tokenized equity pools are too
  // illiquid (5 of 11 tickers had frozen pool prices, remaining 6 had
  // p99 pinned at the 32min histogram cap because arbs rarely close
  // within the settle window). Rob Chain launched Mar 2026, market
  // still too young for an arb-latency bench. Spec deleted + arb_tracker
  // removed from tokenized-stock-peg harness. Kept in 410 list for any
  // indexed URL. Bench 077 tokenized-stock-peg + 079 weekend-drift
  // (static peg measurements) stay on prod as the honest signal.
  "tokenized-stock-arb-latency",
  // token-trade-coverage (090) dropped 2026-07-24: self-baseline bias
  // (Mobula pinned at 100% because it returned the highest raw counts).
  // Spec + harness removed; rebuild needs RPC-derived ground truth.
  "token-trade-coverage",
  // solana-dex-quote-latency (029) held back 2026-07-24: OpenOcean 403s on
  // Railway ASN (Cloudflare block, permanent), Raydium single-venue no-routes
  // on the Pulse V2 bonded-token rotation. Board shows 2 of 4 providers as
  // Unavailable which reads as "half broken" to visitors even though it's
  // honest signal. Kept on dev/staging while we decide whether to swap in
  // DFlow (needs partnership key) + drop the two dead providers.
  "solana-dex-quote-latency",
  // staging pipeline, held back until validated / announced
  "rpc-keyed-latency",
  "explorer-chain-coverage",
  "portfolio-chain-coverage",
]);

/**
 * Provider slugs whose /products/<slug> route should return 410 Gone
 * rather than 404. Populated when a provider that once had a product
 * page loses ALL its bench appearances.
 *
 * Enforced only in src/middleware.ts. The /products/[slug] page
 * already calls notFound() when getProvider() returns null; this set
 * exists purely to swap the resulting 404 for a 410 on prod.
 */
export const REMOVED_PRODUCT_SLUGS = new Set([
  // bitquery was only referenced in bench 090 token-trade-coverage,
  // dropped 2026-07-24. Product page was live briefly, so Google
  // likely indexed the URL. 410 speeds de-indexing.
  "bitquery",
]);

