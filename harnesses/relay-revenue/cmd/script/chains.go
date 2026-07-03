package main

// chains.go — Relay chainId → native pricing token mapping.
//
// We need to convert raw gas (paid in the chain's native asset) and
// native-denominated swap legs into USD. Relay returns the chain by its
// numeric `chainId`. Adding a row enables BOTH gas pricing and native
// asset USD valuation; ERC-20 lookup is configured separately in
// pricer.go (chainSlugs map).
//
// `nativeSymbol` is the symbol Relay sends for this chain's gas asset.
// `nativeCoingeckoID` is the canonical CoinGecko id (preferred over
// symbol when present — symbols collide, ids don't).

// ChainSpec carries the per-chain native-token pricing info plus the
// number of decimals on the native unit.
//
// MobulaNativeAsset is what to pass as ?asset= to Mobula's /market/data
// for this chain's gas token. Mobula's name vocabulary diverges from
// CoinGecko's on several majors (BNB ≠ binancecoin, POL ≠ matic-network,
// AVAX ≠ avalanche-2) — empirically probed against the live API. Empty
// string means "use NativeCoingeckoID" (works for ETH/SOL/BTC).
type ChainSpec struct {
	ChainID           int64
	Name              string
	NativeSymbol      string
	NativeCoingeckoID string
	MobulaNativeAsset string
	NativeDecimals    int
}

// relayChains is keyed by chainId for O(1) lookup. Expanded from the
// initial 18-chain map to cover the full Relay catalog per their
// `/chains` docs as of May 2026. Unknown chains return ok=false from
// chainSpec, which flips the affected swap to priced=false (correct).
var relayChains = map[int64]ChainSpec{
	// ─── EVM L1 & majors ───
	1:     {ChainID: 1, Name: "ethereum", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	56:    {ChainID: 56, Name: "bsc", NativeSymbol: "BNB", NativeCoingeckoID: "binancecoin", MobulaNativeAsset: "BNB", NativeDecimals: 18},
	137:   {ChainID: 137, Name: "polygon", NativeSymbol: "POL", NativeCoingeckoID: "matic-network", MobulaNativeAsset: "POL (ex-MATIC)", NativeDecimals: 18},
	43114: {ChainID: 43114, Name: "avalanche", NativeSymbol: "AVAX", NativeCoingeckoID: "avalanche-2", MobulaNativeAsset: "avalanche", NativeDecimals: 18},
	250:   {ChainID: 250, Name: "fantom", NativeSymbol: "FTM", NativeCoingeckoID: "fantom", NativeDecimals: 18},
	2020:  {ChainID: 2020, Name: "ronin", NativeSymbol: "RON", NativeCoingeckoID: "ronin", NativeDecimals: 18},
	1329:  {ChainID: 1329, Name: "sei", NativeSymbol: "SEI", NativeCoingeckoID: "sei-network", NativeDecimals: 18},
	5000:  {ChainID: 5000, Name: "mantle", NativeSymbol: "MNT", NativeCoingeckoID: "mantle", NativeDecimals: 18},
	80094: {ChainID: 80094, Name: "berachain", NativeSymbol: "BERA", NativeCoingeckoID: "berachain-bera", NativeDecimals: 18},
	33139: {ChainID: 33139, Name: "apechain", NativeSymbol: "APE", NativeCoingeckoID: "apecoin", NativeDecimals: 18},
	1088:  {ChainID: 1088, Name: "metis", NativeSymbol: "METIS", NativeCoingeckoID: "metis-token", NativeDecimals: 18},

	// ─── ETH L2s (all native = ETH) ───
	10:      {ChainID: 10, Name: "optimism", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	130:     {ChainID: 130, Name: "unichain", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	288:     {ChainID: 288, Name: "boba", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	324:     {ChainID: 324, Name: "zksync", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	480:     {ChainID: 480, Name: "worldchain", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	1101:    {ChainID: 1101, Name: "polygon-zkevm", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	1135:    {ChainID: 1135, Name: "lisk", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	1868:    {ChainID: 1868, Name: "soneium", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	7777777: {ChainID: 7777777, Name: "zora", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	8333:    {ChainID: 8333, Name: "b3", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	8453:    {ChainID: 8453, Name: "base", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	34443:   {ChainID: 34443, Name: "mode", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	42161:   {ChainID: 42161, Name: "arbitrum", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	57073:   {ChainID: 57073, Name: "ink", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	59144:   {ChainID: 59144, Name: "linea", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	60808:   {ChainID: 60808, Name: "bob", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	81457:   {ChainID: 81457, Name: "blast", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	534352:  {ChainID: 534352, Name: "scroll", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},

	// ─── Sovereign chains with their own gas token ───
	666666666: {ChainID: 666666666, Name: "degen", NativeSymbol: "DEGEN", NativeCoingeckoID: "degen-base", NativeDecimals: 18},
	999:       {ChainID: 999, Name: "hyperevm", NativeSymbol: "HYPE", NativeCoingeckoID: "hyperliquid", NativeDecimals: 18},
	2741:      {ChainID: 2741, Name: "abstract", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	100:       {ChainID: 100, Name: "gnosis", NativeSymbol: "XDAI", NativeCoingeckoID: "xdai", MobulaNativeAsset: "xDAI", NativeDecimals: 18},
	169:       {ChainID: 169, Name: "manta", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	98866:     {ChainID: 98866, Name: "plume", NativeSymbol: "PLUME", NativeCoingeckoID: "plume", NativeDecimals: 18},
	// TRON via Relay's off-EVM convention (728126428 audited).
	728126428: {ChainID: 728126428, Name: "tron", NativeSymbol: "TRX", NativeCoingeckoID: "tron", NativeDecimals: 6},
	// chainid.network-registered chains observed dropping in audit:
	25:    {ChainID: 25, Name: "cronos", NativeSymbol: "CRO", NativeCoingeckoID: "crypto-com-chain", MobulaNativeAsset: "cronos", NativeDecimals: 18},
	143:   {ChainID: 143, Name: "monad", NativeSymbol: "MON", NativeCoingeckoID: "monad", NativeDecimals: 18},
	360:   {ChainID: 360, Name: "shape", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	48900:  {ChainID: 48900, Name: "zircuit", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	747474: {ChainID: 747474, Name: "katana", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	685689: {ChainID: 685689, Name: "gensyn", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 18},
	// Mythos gaming chain (FIFA Rivals, NFL Rivals); not in chainid.network
	// but confirmed via direct Relay swap inspection. Mobula slug "mythos".
	42018: {ChainID: 42018, Name: "mythos", NativeSymbol: "MYTH", NativeCoingeckoID: "mythos", NativeDecimals: 18},

	// ─── Non-EVM chains Relay routes through ───
	// Solana uses Relay's off-EVM chainId 792703809; native is SOL, 9 decimals.
	792703809: {ChainID: 792703809, Name: "solana", NativeSymbol: "SOL", NativeCoingeckoID: "solana", NativeDecimals: 9},
	// Bitcoin via Relay's BTC bridge. Relay uses 8253038 as the Bitcoin
	// chainId per their public requests API (audited May 2026); 1337 in
	// an earlier draft was a copy-paste from Ethereum local-dev convention.
	8253038: {ChainID: 8253038, Name: "bitcoin", NativeSymbol: "BTC", NativeCoingeckoID: "bitcoin", NativeDecimals: 8},
	// Eclipse (Solana L2 on Ethereum); native is ETH, SVM-style accounts.
	100024: {ChainID: 100024, Name: "eclipse", NativeSymbol: "ETH", NativeCoingeckoID: "ethereum", NativeDecimals: 9},
}

func chainSpec(id int64) (ChainSpec, bool) {
	cs, ok := relayChains[id]
	return cs, ok
}
