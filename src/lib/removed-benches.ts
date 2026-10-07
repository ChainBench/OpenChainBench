/**
 * Which bench slugs production does not serve, and what a hit on one gets.
 *
 * This file holds three sets, and they are NOT interchangeable. Each has its
 * own docblock below; this is the map, because an earlier version of this
 * comment described all of them as one and got the status code wrong.
 *
 *  REMOVED_BENCH_SLUGS   retired for good, plus a few held for review.
 *                        src/middleware.ts answers 410 Gone on prod, which is
 *                        the SEO-correct signal for a URL that was indexed.
 *  RENAMED_BENCH_SLUGS   split or renamed; a 308 to the successor, issued from
 *                        next.config.ts redirects() so it costs no invocation.
 *                        Checked before the 410 so a rename always wins.
 *  DEV_ONLY_BENCH_SLUGS  the staging pipeline: still being validated, or held
 *                        back on purpose. Dropped at the loader, so the page
 *                        404s rather than 410s. Nothing was ever published at
 *                        those URLs, so there is no signal to preserve.
 *
 * The loader gate (src/lib/materialize/load.ts) is what keeps every rendered
 * surface consistent: catalog index, category pages, /rpc hub, compare pairs,
 * /api/citable, /api/stat, llms.txt, RSS, MCP and the Markdown views never
 * link or cite a slug this deployment does not serve. The sitemap is dropped
 * separately in src/lib/sitemap-builder.ts, through the isDevOnlyBench and
 * isDevOnlyRoute helpers below rather than the sets directly, and is served by
 * src/app/sitemap.xml/route.ts (there is no src/app/sitemap.ts; it became a
 * Route Handler so it could set its own Cache-Control).
 *
 * Moving a bench to production = remove its slug from DEV_ONLY_BENCH_SLUGS,
 * bump the bench-set cache keys in src/lib/spec.ts, ship dev to main.
 *
 * TWO PRODUCTION ENDPOINTS DELIBERATELY DO NOT ENFORCE ANY OF THIS, and an
 * audit will find them again: /api/aggregate and /api/sitemap-data serve the
 * worker's blobs verbatim, so on production both carry every dev-only slug
 * with its editorial fields, including an seo_title naming a leader for a
 * bench whose page 404s. Flagged 2026-09-30. They are transport, not a public
 * surface: every Vercel deployment including staging fetches those two routes
 * on the production domain (src/lib/aggregate-blob.ts, src/lib/sitemap-blob.ts),
 * and staging is the only place these benches render, so filtering them there
 * would empty the staging pipeline of all of them. Both routes carry that
 * warning at the top. What bounds the exposure: noindex via the /api/:path*
 * X-Robots-Tag, linked from no page, absent from llms.txt and the OpenAPI
 * document, and no secret in the payload (no keyed URL shape, checked).
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
  // Bench 200 covered Robinhood Chain and Arc pads from 2026-10-07, so a slug
  // promising Solana became false. This one WAS served on production, unlike
  // the two dev-only renames the same week, so it owes a 301 and not a 404.
  "solana-launchpad-wars": "launchpad-wars",
  "network-coverage": "asset-registry-coverage",
  // Keyed RPC cohort folded into the per-chain RPC pages (2026-09-21):
  // one page per chain, the private (API-key) providers behind the
  // Endpoints selector. The target is the clean canonical URL; the
  // `#tier=keyed` fragment opens the Private tab client-side and is not
  // a distinct document for crawlers. A value may carry a fragment. Only robinhood was ever on production, the
  // other eight were dev-only, but their URLs were shared.
  "keyed-rpc-ethereum": "ethereum-rpc#tier=keyed",
  "keyed-rpc-arbitrum": "arbitrum-rpc#tier=keyed",
  "keyed-rpc-base": "base-rpc#tier=keyed",
  "keyed-rpc-bnb": "bnb-rpc#tier=keyed",
  "keyed-rpc-polygon": "polygon-rpc#tier=keyed",
  "keyed-rpc-solana": "solana-rpc#tier=keyed",
  "keyed-rpc-hyperliquid": "hyperliquid-rpc#tier=keyed",
  "keyed-rpc-robinhood": "robinhood-rpc#tier=keyed",
  "keyed-rpc-arc": "arc-rpc#tier=keyed",
};

/**
 * Answer pages (answers/<slug>.yml) whose referenced benchmark is in
 * REMOVED_BENCH_SLUGS. Same treatment: 410 on prod direct hits, dropped
 * from the answers listing and sitemap on prod, normal on staging.
 */
export const REMOVED_ANSWER_SLUGS = new Set([
  "which-evm-aggregator-has-the-fastest-quote",
  "which-solana-rpc-lands-the-most-transactions",
  // References solana-dex-quote-latency (staging-only, in
  // REMOVED_BENCH_SLUGS). Same pattern.
  "which-solana-dex-aggregator-is-the-fastest",
  // References pm-data-freshness (bench 113, retired 2026-07). Bench
  // removed; answer returns 404 without this guard.
  "which-prediction-market-data-api-is-the-freshest",
  // References pm-fee-comparison (dropped 2026-07). The YAML also
  // hand-types "2% fee" and "vig roughly 4-10%", so it must not be
  // revived as written. 410 instead of 404 (SEO audit 2026-09-22).
  "polymarket-fees-explained",
  // Same class, found by the next audit: references pm-fee-comparison too,
  // and hand-types "flat 2%", "roughly $0.07" and a "$0.20 / $0.80"
  // crossover. 410 instead of 404 (SEO audit 2026-09-23).
  "polymarket-vs-kalshi-fees",
]);

/**
 * Benches that stay on dev / staging / preview and never reach production
 * (VERCEL_ENV === "production"): still being validated, or held back on
 * purpose. Enforced generically, so a release needs no per-file surgery:
 *  1. src/lib/materialize/load.ts drops the specs at loader level on prod,
 *     so pages 404, and hubs, category pages, /rpc, compare pairs,
 *     /api/citable, llms.txt, MCP and RSS never list or cite them.
 *  2. src/lib/sitemap-builder.ts drops them from the worker's blob (the
 *     worker runs from dev and publishes every bench) and from the
 *     product recount.
 *  3. Components tied to one of these benches check that the bench is
 *     served by this deployment before rendering (TerminalFillSection).
 * Moving a bench to production = remove its slug here.
 */
export const DEV_ONLY_BENCH_SLUGS = new Set([
  // 208 perp liquidation rate: gated 2026-09-28 while the metric is rebuilt.
  // The sources are right (the Gains decode reproduces to 0.02% against an
  // independent scan, Lighter, GMX, Aster, Ostium, Nado and Orderly read
  // their feeds) and the headline is not: a 24h window is meaningless on a
  // venue whose nine-day total sits in three days, a book liquidated away
  // inside the window makes the rate exceed 100% on any open-interest
  // denominator, and notional over notional open interest mostly reports a
  // venue's leverage policy (Gains: $39.5M of notional on $423k of
  // collateral on 2026-09-28, median 73x). Un-gate condition: the headline
  // is a 30-day flow over flow (liquidated notional over traded notional,
  // 7-day companion) with collateral lost and median leverage published per
  // venue where the source exposes them, open interest as context only,
  // the page saying plainly that a high rate on a high-leverage venue
  // reflects the leverage it offers, and an audit round on that board.
  "perp-liq-rate",
  // 282 RPC cost: held back from the release of 2026-09-30 while three
  // findings from that day's audit are settled. The Access selector renders
  // the word "Access" sixteen times on a cost bench because
  // benchmark-body.tsx hardcodes the label instead of reading
  // dimension_labels.tier, which the spec already sets to "Billing model".
  // Two comments in the harness give GetBlock's archive multiplier as 1.5x
  // where the catalogue computes 2x for plain reads and 3x for debug and
  // trace. And there is an open suspicion that the Chainstack trace profile
  // double counts, doubling a weighted total whose two trace methods are
  // already priced at 2 RU, which would publish 4 RU per call. The first two
  // are wording; the third is a number on a published column and needs a
  // bench audit before a reader sees it. Un-gate condition: the label wired,
  // the multiplier comments corrected, and the trace profile confirmed
  // against the catalogue.
  "rpc-cost",
  // Bench 284 trading-agent-alpha was gated here on 2026-10-06 and released on
  // 2026-10-07 with /trading-agents. The condition was a clean bench audit, a
  // clean SEO audit and a second weekly round observed; all three were met,
  // and a fourth was added along the way and met too: the table had to stop
  // reading as a ranking, because zero of its 28 pairwise comparisons clears
  // significance and the copy saying so could not outvote a sorted leaderboard
  // with a bold first place. It is now grouped by lab, ordered alphabetically,
  // and banners the tie above the table.
  // Released 2026-09-23: bridges 261 (on-chain execution), 263 (realized
  // cost), 264 (SOL->X quotes) and 268 terminal-fill-quality left this
  // list with release/2026-09-23.
  // 262 fiat on-ramp cost: two providers (MoonPay, Transak) with keys; the
  // release condition is more than two keyed providers. Was held off main
  // by its spec's absence there until release/2026-09-23 brought it.
  "fiat-onramp-cost",
  // 273 chain-bridged-tvl, 274 protocol-pf-ratio and 275 chain-stablecoin-flow
  // left this list on 2026-09-25 (windows full, audit round clean).
  // 280 chain fees and revenue: new gauges on the chain-kpis harness
  // (2026-09-25), no 24h window yet and no audit round. Un-gate after both.
  "chain-fees-revenue",
  // 281 USDC corridor flows: first deploy of the bridge-flows harness
  // (CCTP burns over public RPCs), the 7d window fills over its first
  // week and no audit round yet. Un-gate after both.
  "usdc-corridor-flows",
  // 276 perp fee disclosure: the maker gauge is one deploy old and three
  // of the eight rows have no maker rate at all. Un-gate after a 24h
  // window and an audit round.
  "perp-fee-disclosure",
  // Benches 203, 206, 207 and 232 left this list on 2026-10-07.
  //
  // They were gated on 2026-10-02 when the Dune trial ended, under a note
  // saying they "have no free equivalent for what they measure". They were
  // re-sourced the same week to the public tehcscreener API (Allium-backed,
  // no key) via harnesses/terminal-activity: a different vendor, not a
  // cheaper route to the same one. Bench 201 had already moved to DeFiLlama.
  //
  // Un-gated after the audit round rather than after a 24h window, because
  // these four read instant gauges and declare no range selector: the only
  // thing a day buys them is a complete chart, which is cosmetic. What the
  // audit round caught is in #2843, #2844, #2846, #2848 and #2849.
  //
  // 206 and 207 were renamed on the way out, from solana-avg-trade-size and
  // solana-unique-traders. Neither was ever served on production, so there is
  // no signal to preserve and no redirect is owed: their default view is
  // all-chains now and the old slugs claimed otherwise.
]);

/**
 * Routes (whole pages, with their API) that stay off production the same
 * way: the page renders notFound() on prod, the sitemap, the footer,
 * llms.txt and the /rpc hub stop linking them there. Staging shows them.
 */
export const DEV_ONLY_ROUTES = new Set<string>([
  // The map waits for its data; the speed test that produces it does not.
  //
  // Both shipped on 2026-09-30 to break the deadlock that had kept them
  // off production since 2026-09-21: the speed test is the only source of
  // contributions, so gating it guaranteed the map would never fill, and
  // nine gated days had produced exactly zero samples. Publishing the
  // test was the half that mattered. The map went with it and should not
  // have: an honest empty state still asks a reader to look at a world
  // map with nothing on it, which is a worse first impression than not
  // offering the page at all.
  //
  // So /speedtest-rpc stays on production and keeps collecting, and the
  // map comes back once there is something to draw. Collection does NOT
  // depend on this line: /api/speedtest/contribute is gated on
  // "/speedtest-rpc", and it derives the city cell server-side from
  // Vercel's IP headers, so it needs neither the map page nor
  // /api/speedtest/whereami (which only serves the map's "near me" pin).
  //
  // Un-gate condition: enough cells that the map reads as a map. Check
  // with `curl .../api/speedtest/map?chain=ethereum` on staging, which
  // reports `total` (every contribution ever) and `cells`. It was 0 and 0
  // on 2026-09-30.
  "/rpc-map",
  // /trading-agents was gated here on 2026-10-06 and released on 2026-10-07
  // together with its bench, which was the point: the aggregate blob is shared
  // between environments, so an un-gated hub would have rendered a full table
  // on production whose every row linked to a 404.
]);

export const IS_PRODUCTION = process.env.VERCEL_ENV === "production";

/** True when this deployment must not serve the bench. */
export function isDevOnlyBench(slug: string): boolean {
  return IS_PRODUCTION && DEV_ONLY_BENCH_SLUGS.has(slug);
}

/** True when this deployment must not serve the route. */
export function isDevOnlyRoute(path: string): boolean {
  return IS_PRODUCTION && DEV_ONLY_ROUTES.has(path);
}

export const REMOVED_BENCH_SLUGS = new Set([
  // Six chain RPC benches retired 2026-10-02 after an audit of all 161.
  // Each was probed on the usual schedule and produced nothing rankable:
  // every declared endpoint was re-tested by hand on the day, and the
  // chains below have no public RPC that answers us at all.
  //
  //   quicksilver   0 of 3 endpoints alive, last sample 29 days old
  //   thundercore   0 of 3 (two answer 503), 24 days
  //   canto         0 of 1 (connection times out), 24 days
  //   neon          0 of 3, 8 days
  //   plume         0 of 1 (drpc answers 400), probe fresh
  //   zetachain     1 endpoint alive, 0.37 % success, probe fresh
  //
  // The last two are the interesting pair: the probe is running and the
  // data is current, and what it says is that nobody answers. zetachain's
  // one endpoint is Thirdweb, which serves browsers and refuses our probe
  // hosts everywhere (0.3 % to 1.5 % across 29 chains, see #2779).
  //
  // Specs and harness entries deleted; the slugs stay here so an indexed
  // URL answers 410 Gone rather than 404. Un-gate condition: a public
  // endpoint on that chain that answers us. plume keeps its /chains page,
  // which carries chain-bridged-tvl and chain-fees-revenue; the other five
  // had nothing but the RPC bench and leave the chain registry with it.
  "quicksilver-rpc",
  "thundercore-rpc",
  "canto-rpc",
  "neon-rpc",
  "plume-rpc",
  "zetachain-rpc",
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
  // cross-chain-messaging-latency dropped 2026-07-27: apples-to-oranges
  // by construction. Each protocol self-reports via its own tracker
  // (LZ Scan, Axelarscan, Hyperlane Nexus, CCIP Explorer) so there's
  // no shared methodology, no independent ground truth. On top of that
  // they don't measure the same thing (Hyperlane instant attestation
  // vs CCIP structural finality wait) and rolling every source→dest
  // pair into one p50 hides the story entirely. Spec deleted; the four
  // per-protocol benches (axelar-gmp-latency, chainlink-ccip-latency,
  // hyperlane-message-latency, layerzero-message-latency) + wormhole
  // stay on prod as the honest signal.
  "cross-chain-messaging-latency",
  // solana-dex-quote-latency (029) held back 2026-07-24: OpenOcean 403s on
  // Railway ASN (Cloudflare block, permanent), Raydium single-venue no-routes
  // on the Pulse V2 bonded-token rotation. Board shows 2 of 4 providers as
  // Unavailable which reads as "half broken" to visitors even though it's
  // honest signal. Kept on dev/staging while we decide whether to swap in
  // DFlow (needs partnership key) + drop the two dead providers.
  "solana-dex-quote-latency",
  // staging pipeline, held back until validated / announced
  "explorer-chain-coverage",
  "portfolio-chain-coverage",
  // pm-data-freshness (bench 113) retired 2026-07: Predexon (the only
  // measured data relay) discontinued. Spec + harness removed; kept in
  // the 410 list so any indexed URL returns Gone instead of 404.
  // Per-venue WS freshness now lives in pm-ws-latency (bench 114).
  "pm-data-freshness",
  // perp-open-interest retired 2026-07: multi-chain OI aggregation was
  // structurally biased (each venue self-reports; no independent
  // ground truth). Spec deleted; kept for indexed URL cleanup.
  "perp-open-interest",
  // pm-fee-comparison and pm-geographic-access dropped 2026-07
  // (see PR #1663/#1664): fee-comparison was apples-to-oranges across
  // venue types; geographic-access relied on ForecastEx geo blocks that
  // changed without notice. Specs deleted.
  "pm-fee-comparison",
  "pm-geographic-access",
  // polymarket-resolution-delay was drafted in a worktree but never merged
  // to main. Answer pages originally referenced it; those were updated to
  // pm-resolution-delay (2026-08-04). A 308 redirect covers inbound links.
  // Adding here prevents stale Redis data from re-appearing in the sitemap.
  "polymarket-resolution-delay",
  // indexing-freshness (070) retired 2026-08-05: cohort reduced to 3
  // providers (Zerion, Mobula, Allium) after GoldRush 402s and Moralis
  // removal; a 3-provider bench is not strong enough signal for a
  // standalone page. Spec kept for carry-forward; 410 on prod.
  "indexing-freshness",
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
  // goldrush (Covalent) was removed from indexing-freshness bench in
  // 2026-08-04 data-api report (PR #1758). Stale Redis data can keep
  // the provider in getProviders() output while the page 404s; 410 guard
  // + sitemap exclusion stop the smoke-gate rollback until Redis flushes.
  "goldrush",
  // zerion and routescan appear in stale Redis results from retired benches
  // (indexing-freshness for zerion, explorer-chain-coverage for routescan)
  // but have no /products/<slug> page. 410 guard prevents smoke-gate failures.
  "zerion",
  "routescan",
]);

