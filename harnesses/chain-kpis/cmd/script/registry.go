package main

// Chain is one OCB-tracked chain with its source-of-truth mappings.
// The slug field MUST match the OCB site's `src/lib/chains.ts` registry so
// the Prom selector `{chain="<slug>"}` matches what the bench page reads.
//
// DefiLlama name: the canonical chain name DefiLlama uses on
//   /v2/historicalChainTvl/<name>, /overview/dexs/<name>, and
//   /stablecoincharts/<name>. Verified live by reading
//   https://api.llama.fi/v2/chains and matching exact casing.
//   Empty = DefiLlama doesn't cover this chain (Monero today).
//
// Mobula name: the value the harness passes as ?blockchain=<name> to
//   /api/1/market/blockchain/stats. Verified live by reading
//   /api/1/blockchains and matching. Empty = unsupported.
//
// Native symbol: the canonical native-token symbol Mobula serves via
//   /api/1/market/data?symbol=<sym>. Verified live, 100% coverage.
type Chain struct {
	Slug         string
	DefiLlama    string
	Mobula       string
	NativeSymbol string
}

// Registry is the canonical list of OCB-tracked chains.
// Order = display order in the /chains hub.
// Mirror of src/lib/chains.ts CHAINS array on the OCB site, kept in sync
// manually. Adding a new chain: append here, append on the site, redeploy
// both. New rows take effect on the next harness tick.
var Registry = []Chain{
	// L1
	{Slug: "ethereum", DefiLlama: "Ethereum", Mobula: "Ethereum", NativeSymbol: "ETH"},
	{Slug: "solana", DefiLlama: "Solana", Mobula: "Solana", NativeSymbol: "SOL"},
	{Slug: "bnb", DefiLlama: "BSC", Mobula: "BNB Smart Chain (BEP20)", NativeSymbol: "BNB"},
	{Slug: "avalanche", DefiLlama: "Avalanche", Mobula: "Avalanche C-Chain", NativeSymbol: "AVAX"},
	{Slug: "sui", DefiLlama: "Sui", Mobula: "Sui", NativeSymbol: "SUI"},
	// Site canonical slug is "gram" since the Toncoin to Gram rename; the
	// old "ton" label made the Prom selector miss and the KV blob stay null.
	// Mobula still serves the asset under symbol TON: symbol GRAM resolves
	// to an unrelated "GRAM Token" (~$24M mcap), verified live 2026-07-08.
	// The stats endpoint still accepts blockchain=TON even though it is
	// absent from /api/1/blockchains.
	{Slug: "gram", DefiLlama: "TON", Mobula: "TON", NativeSymbol: "TON"},
	{Slug: "stellar", DefiLlama: "Stellar", Mobula: "", NativeSymbol: "XLM"},
	{Slug: "tron", DefiLlama: "Tron", Mobula: "TRON", NativeSymbol: "TRX"},
	{Slug: "cardano", DefiLlama: "Cardano", Mobula: "", NativeSymbol: "ADA"},
	{Slug: "litecoin", DefiLlama: "Litecoin", Mobula: "", NativeSymbol: "LTC"},
	{Slug: "monero", DefiLlama: "", Mobula: "", NativeSymbol: "XMR"},
	{Slug: "polygon", DefiLlama: "Polygon", Mobula: "Polygon", NativeSymbol: "POL"},
	// L2
	{Slug: "arbitrum", DefiLlama: "Arbitrum", Mobula: "Arbitrum", NativeSymbol: "ETH"},
	{Slug: "optimism", DefiLlama: "Optimism", Mobula: "Optimistic", NativeSymbol: "ETH"},
	{Slug: "base", DefiLlama: "Base", Mobula: "Base", NativeSymbol: "ETH"},
	{Slug: "robinhood", DefiLlama: "Robinhood Chain", Mobula: "Robinhood Chain", NativeSymbol: "ETH"},
	{Slug: "zksync", DefiLlama: "ZKsync Era", Mobula: "ZkSync", NativeSymbol: "ETH"},
	{Slug: "linea", DefiLlama: "Linea", Mobula: "Linea", NativeSymbol: "ETH"},
	{Slug: "scroll", DefiLlama: "Scroll", Mobula: "Scroll", NativeSymbol: "ETH"},
	{Slug: "blast", DefiLlama: "Blast", Mobula: "Blast", NativeSymbol: "ETH"},
	{Slug: "mantle", DefiLlama: "Mantle", Mobula: "Mantle", NativeSymbol: "MNT"},
	{Slug: "taiko", DefiLlama: "Taiko", Mobula: "Taiko", NativeSymbol: "ETH"},
	// Chains added to the site registry after the original harness config
	// was written; they published all-null KV blobs until this batch.
	// Every DefiLlama name below verified live against /v2/chains,
	// /overview/dexs/<name> and /stablecoincharts/<name> on 2026-07-08.
	// Mobula blockchain names verified against /api/1/blockchains; empty
	// means Mobula does not index the chain yet (only the tokens-indexed
	// gauge is lost, the KPI strip does not read it).
	{Slug: "monad", DefiLlama: "Monad", Mobula: "", NativeSymbol: "MON"},
	{Slug: "megaeth", DefiLlama: "MegaETH", Mobula: "MegaETH", NativeSymbol: "ETH"},
	{Slug: "sonic", DefiLlama: "Sonic", Mobula: "Sonic", NativeSymbol: "S"},
	// Gnosis gas is xDAI but the site strip labels the native token GNO,
	// so we publish GNO to match what the page displays. Mobula indexes
	// the chain under its legacy XDAI name.
	{Slug: "gnosis", DefiLlama: "Gnosis", Mobula: "XDAI", NativeSymbol: "GNO"},
	{Slug: "celo", DefiLlama: "Celo", Mobula: "Celo", NativeSymbol: "CELO"},
	{Slug: "moonbeam", DefiLlama: "Moonbeam", Mobula: "Moonbeam", NativeSymbol: "GLMR"},
	{Slug: "unichain", DefiLlama: "Unichain", Mobula: "", NativeSymbol: "ETH"},
	{Slug: "berachain", DefiLlama: "Berachain", Mobula: "Berachain", NativeSymbol: "BERA"},
	{Slug: "cronos", DefiLlama: "Cronos", Mobula: "Cronos", NativeSymbol: "CRO"},
	// Fraxtal gas is frxETH, so we follow the same gas-token convention as
	// the ETH rollups. Mobula symbol FRAX resolves to the legacy Frax
	// stablecoin (~$1), the wrong asset for a native-token card.
	{Slug: "fraxtal", DefiLlama: "Fraxtal", Mobula: "", NativeSymbol: "FRXETH"},
	{Slug: "soneium", DefiLlama: "Soneium", Mobula: "", NativeSymbol: "ETH"},
	// Polkadot relay chain. DefiLlama tracks the chain name but reports
	// zero TVL and 500s on the DEX endpoint: relay chain has no DeFi and
	// parachain DeFi (Acala, Moonbeam, Hydration) lives under those slugs.
	// Stables endpoint returns real values via Asset Hub USDC/USDT
	// issuance. DOT native price and mcap flow through Mobula. The zero
	// TVL guard in defillama.go drops the empty TVL card so only real
	// cards render.
	{Slug: "polkadot", DefiLlama: "Polkadot", Mobula: "", NativeSymbol: "DOT"},
}
