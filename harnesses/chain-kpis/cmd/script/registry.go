package main

// Chain is one OCB-tracked chain with its source-of-truth mappings.
// The slug field MUST match the OCB site's `src/lib/chains.ts` registry so
// the Prom selector `{chain="<slug>"}` matches what the bench page reads.
//
// DefiLlama name: the canonical chain name DefiLlama uses on
//
//	/v2/historicalChainTvl/<name>, /overview/dexs/<name>, and
//	/stablecoincharts/<name>. Verified live by reading
//	https://api.llama.fi/v2/chains and matching exact casing.
//	Empty = DefiLlama doesn't cover this chain (Monero today).
//
// Mobula name: the value the harness passes as ?blockchain=<name> to
//
//	/api/1/market/blockchain/stats. Verified live by reading
//	/api/1/blockchains and matching. Empty = unsupported.
//
// Native symbol: the canonical native-token symbol Mobula serves via
//
//	/api/1/market/data?symbol=<sym>. Verified live, 100% coverage.
//
// L2Beat id: the project key under `projects` on
//
//	https://l2beat.com/api/scaling/summary, whose tvs.breakdown splits the
//	chain's value secured into native / canonical / external. Set it for
//	every chain L2Beat tracks, which is not the same as "only rollups":
//	Polygon PoS, Gnosis and Hyperliquid run their own consensus and are
//	tracked. A settled L1 has no host chain and so no bridged balance, and
//	the field stays empty there. Ids verified live against that endpoint;
//	several differ from the OCB slug (polygon-pos, zksync2, roninnetwork,
//	worldchain, mantapacific, galxegravity, nova, polygonzkevm,
//	bobanetwork, immutablezkevm). A chain added here needs a row on bench
//	273 too: TestEveryMappedChainHasABenchRow fails otherwise.
type Chain struct {
	Slug         string
	DefiLlama    string
	Mobula       string
	NativeSymbol string
	L2Beat       string
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
	{Slug: "polygon", DefiLlama: "Polygon", Mobula: "Polygon", NativeSymbol: "POL", L2Beat: "polygon-pos"},
	// L2
	{Slug: "arbitrum", DefiLlama: "Arbitrum", Mobula: "Arbitrum", NativeSymbol: "ETH", L2Beat: "arbitrum"},
	{Slug: "optimism", DefiLlama: "Optimism", Mobula: "Optimistic", NativeSymbol: "ETH", L2Beat: "optimism"},
	{Slug: "base", DefiLlama: "Base", Mobula: "Base", NativeSymbol: "ETH", L2Beat: "base"},
	{Slug: "robinhood", DefiLlama: "Robinhood Chain", Mobula: "Robinhood Chain", NativeSymbol: "ETH", L2Beat: "robinhood"},
	{Slug: "zksync", DefiLlama: "ZKsync Era", Mobula: "ZkSync", NativeSymbol: "ETH", L2Beat: "zksync2"},
	{Slug: "linea", DefiLlama: "Linea", Mobula: "Linea", NativeSymbol: "ETH", L2Beat: "linea"},
	{Slug: "scroll", DefiLlama: "Scroll", Mobula: "Scroll", NativeSymbol: "ETH", L2Beat: "scroll"},
	{Slug: "blast", DefiLlama: "Blast", Mobula: "Blast", NativeSymbol: "ETH", L2Beat: "blast"},
	{Slug: "mantle", DefiLlama: "Mantle", Mobula: "Mantle", NativeSymbol: "MNT", L2Beat: "mantle"},
	{Slug: "taiko", DefiLlama: "Taiko", Mobula: "Taiko", NativeSymbol: "ETH", L2Beat: "taiko"},
	// Chains added to the site registry after the original harness config
	// was written; they published all-null KV blobs until this batch.
	// Every DefiLlama name below verified live against /v2/chains,
	// /overview/dexs/<name> and /stablecoincharts/<name> on 2026-07-08.
	// Mobula blockchain names verified against /api/1/blockchains; empty
	// means Mobula does not index the chain yet (only the tokens-indexed
	// gauge is lost, the KPI strip does not read it).
	{Slug: "monad", DefiLlama: "Monad", Mobula: "", NativeSymbol: "MON"},
	{Slug: "megaeth", DefiLlama: "MegaETH", Mobula: "MegaETH", NativeSymbol: "ETH", L2Beat: "megaeth"},
	{Slug: "sonic", DefiLlama: "Sonic", Mobula: "Sonic", NativeSymbol: "S"},
	// Gnosis gas is xDAI but the site strip labels the native token GNO,
	// so we publish GNO to match what the page displays. Mobula indexes
	// the chain under its legacy XDAI name.
	{Slug: "gnosis", DefiLlama: "Gnosis", Mobula: "XDAI", NativeSymbol: "GNO", L2Beat: "gnosis"},
	{Slug: "celo", DefiLlama: "Celo", Mobula: "Celo", NativeSymbol: "CELO", L2Beat: "celo"},
	{Slug: "moonbeam", DefiLlama: "Moonbeam", Mobula: "Moonbeam", NativeSymbol: "GLMR"},
	{Slug: "unichain", DefiLlama: "Unichain", Mobula: "", NativeSymbol: "ETH", L2Beat: "unichain"},
	{Slug: "berachain", DefiLlama: "Berachain", Mobula: "Berachain", NativeSymbol: "BERA"},
	{Slug: "cronos", DefiLlama: "Cronos", Mobula: "Cronos", NativeSymbol: "CRO"},
	// Fraxtal gas is frxETH, so we follow the same gas-token convention as
	// the ETH rollups. Mobula symbol FRAX resolves to the legacy Frax
	// stablecoin (~$1), the wrong asset for a native-token card.
	{Slug: "fraxtal", DefiLlama: "Fraxtal", Mobula: "", NativeSymbol: "FRXETH", L2Beat: "fraxtal"},
	{Slug: "soneium", DefiLlama: "Soneium", Mobula: "", NativeSymbol: "ETH", L2Beat: "soneium"},
	// Polkadot relay chain. DefiLlama tracks the chain name but reports
	// zero TVL and 500s on the DEX endpoint: relay chain has no DeFi and
	// parachain DeFi (Acala, Moonbeam, Hydration) lives under those slugs.
	// Stables endpoint returns real values via Asset Hub USDC/USDT
	// issuance. DOT native price and mcap flow through Mobula. The zero
	// TVL guard in defillama.go drops the empty TVL card so only real
	// cards render.
	{Slug: "polkadot", DefiLlama: "Polkadot", Mobula: "", NativeSymbol: "DOT"},
	// HyperEVM (chain id 999). Hyperliquid Labs's EVM execution layer
	// bolted onto the HyperCore perps engine. DefiLlama tracks it as
	// "Hyperliquid L1" (verified live on /v2/chains, TVL >$1B), Mobula
	// indexes it under "HyperEVM". Native HYPE serves as gas + trading
	// asset (Mobula symbol HYPE resolves to the correct market data,
	// ~$58 spot / ~$13.9B mcap verified live 2026-07-25).
	{Slug: "hyperliquid", DefiLlama: "Hyperliquid L1", Mobula: "HyperEVM", NativeSymbol: "HYPE", L2Beat: "hyperliquid"},
	// Sei EVM (chain 1329). Cosmos SDK L1 with parallel-execution EVM
	// layer. DefiLlama tracks it as "Sei" (verified /v2/chains 2026-07-26).
	// Mobula left empty until the free-tier blockchains endpoint is
	// re-accessible with a key; the KPI page renders fine with just
	// DefiLlama fees/TVL/stables. Native SEI serves as gas for both
	// the Cosmos and EVM sides.
	{Slug: "sei", DefiLlama: "Sei", Mobula: "", NativeSymbol: "SEI"},
	// Mode (chain 34443). OP Stack L2 in the Base ecosystem, DeFi + AI
	// positioning. DefiLlama slug "Mode" verified.
	{Slug: "mode", DefiLlama: "Mode", Mobula: "", NativeSymbol: "ETH", L2Beat: "mode"},
	// Ronin (chain 2020). Sky Mavis' EVM gaming L1, home of Axie /
	// Pixels and a broader gaming stack. DefiLlama slug "Ronin" verified.
	// RON native token.
	{Slug: "ronin", DefiLlama: "Ronin", Mobula: "", NativeSymbol: "RON", L2Beat: "roninnetwork"},
	// Immutable zkEVM (chain 13371). Polygon CDK zkEVM L2 dedicated to
	// Web3 gaming, operated by Immutable. DefiLlama slug "Immutable zkEVM"
	// verified — the space is intentional and matches /v2/chains casing.
	{Slug: "immutable", DefiLlama: "Immutable zkEVM", Mobula: "", NativeSymbol: "IMX", L2Beat: "immutablezkevm"},
	// Chains the site renders that L2Beat tracks but the registry did not
	// carry. Three of them (Starknet, World Chain, Ink) clear the $200M
	// median floor, so they were voting on the yardstick every other row
	// is judged against while having no row of their own. DefiLlama and
	// Mobula names are left empty deliberately: those loops skip an empty
	// name, so these rows publish L2Beat gauges only until someone
	// verifies the other two sources for each chain. Ids read live from
	// /api/scaling/summary on 2026-09-23; several differ from the site
	// slug (worldchain, mantapacific, galxegravity, nova, polygonzkevm,
	// bobanetwork).
	{Slug: "starknet", DefiLlama: "", Mobula: "", NativeSymbol: "STRK", L2Beat: "starknet"},
	{Slug: "world-chain", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "worldchain"},
	{Slug: "ink", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "ink"},
	{Slug: "morph", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "morph"},
	{Slug: "xlayer", DefiLlama: "", Mobula: "", NativeSymbol: "OKB", L2Beat: "xlayer"},
	{Slug: "manta", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "mantapacific"},
	{Slug: "bob", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "bob"},
	{Slug: "abstract", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "abstract"},
	{Slug: "gravity", DefiLlama: "", Mobula: "", NativeSymbol: "G", L2Beat: "galxegravity"},
	{Slug: "lisk", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "lisk"},
	{Slug: "metis", DefiLlama: "", Mobula: "", NativeSymbol: "METIS", L2Beat: "metis"},
	{Slug: "apechain", DefiLlama: "", Mobula: "", NativeSymbol: "APE", L2Beat: "apechain"},
	{Slug: "zircuit", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "zircuit"},
	{Slug: "arbitrum-nova", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "nova"},
	{Slug: "polygon-zkevm", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "polygonzkevm"},
	{Slug: "boba", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "bobanetwork"},
	{Slug: "zora", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "zora"},
	{Slug: "reya", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "reya"},
	{Slug: "cyber", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "cyber"},
	{Slug: "hemi", DefiLlama: "", Mobula: "", NativeSymbol: "ETH", L2Beat: "hemi"},
	// Plume: L2Beat tracks it as "plumenetwork" (Plume Network, about $89M
	// TVS on 2026-09-25); the bench 273 audit found the site row with no
	// bridged TVL because the id was never mapped. DefiLlama and Mobula
	// names left empty until verified, same as the batch above.
	{Slug: "plume", DefiLlama: "", Mobula: "", NativeSymbol: "PLUME", L2Beat: "plumenetwork"},
}
