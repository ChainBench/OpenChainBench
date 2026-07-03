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
	{Slug: "ton", DefiLlama: "TON", Mobula: "TON", NativeSymbol: "TON"},
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
	{Slug: "zksync", DefiLlama: "ZKsync Era", Mobula: "ZkSync", NativeSymbol: "ETH"},
	{Slug: "linea", DefiLlama: "Linea", Mobula: "Linea", NativeSymbol: "ETH"},
	{Slug: "scroll", DefiLlama: "Scroll", Mobula: "Scroll", NativeSymbol: "ETH"},
	{Slug: "blast", DefiLlama: "Blast", Mobula: "Blast", NativeSymbol: "ETH"},
	{Slug: "mantle", DefiLlama: "Mantle", Mobula: "Mantle", NativeSymbol: "MNT"},
	{Slug: "taiko", DefiLlama: "Taiko", Mobula: "Taiko", NativeSymbol: "ETH"},
}
