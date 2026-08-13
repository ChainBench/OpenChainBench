/**
 * Providers with real search demand as brand-vs-brand comparisons.
 *
 * Sitemap emission rule (src/app/sitemap.ts):
 *   - Curated pairs (src/data/compare-pairs.ts): always emit.
 *   - Both providers in this whitelist: emit at ≥ 1 shared benchmark.
 *   - Otherwise: emit only at ≥ 3 shared benchmarks.
 *
 * Rationale: the old ≥ 1 threshold produced 4938 ad-hoc URLs, 97% of which
 * were near-duplicate templates over obscure providers with no search
 * intent. Bing indexed 2 pages out of 5093, penalising the whole domain.
 * This whitelist keeps every commercial "X vs Y" comparison a user might
 * actually search for (helius-vs-mobula, alchemy-vs-moralis, chain-vs-chain,
 * perp-vs-perp) while dropping the templated garbage.
 *
 * Adding a provider here is cheap. Only add ones that (a) have a
 * dedicated /products/<slug> or /chains/<slug> page, and (b) are named
 * targets in provider outreach or already show up in query data.
 */
export const BRAND_WHITELIST: ReadonlySet<string> = new Set([
  // Aggregators data
  "mobula", "codex", "geckoterminal", "jupiter", "dune", "moralis",
  "alchemy", "birdeye",
  // RPC providers benched by OCB
  "publicnode", "drpc", "1rpc", "tenderly", "helius", "nodies",
  "lava", "meowrpc", "flashbots", "cloudflare",
  // Perp DEXes
  "hyperliquid", "lighter", "dydx", "aster", "paradex", "gmx", "vertex",
  "ostium", "pacifica", "grvt", "extended", "edgex",
  // Bridges
  "debridge", "lifi", "relay", "across", "cctp", "near-intents",
  // Prediction market venues
  "polymarket", "kalshi", "manifold", "myriad", "limitless",
  // CEX / centralized venues (perp funding, oracle deviation)
  "binance", "coinbase", "okx", "bybit",
  // Stablecoins
  "usdc", "usdt", "dai", "usde", "fdusd",
  // NFT & explorers
  "opensea", "blockscout",
  // HL frontends flagged as curated targets
  "axiom", "phantom-perps",
  // Chains (compare pages already work; whitelist keeps chain-vs-chain live)
  "ethereum", "solana", "base", "arbitrum", "optimism", "polygon",
  "avalanche", "sui", "monero", "ton", "bnb", "zksync",
]);
