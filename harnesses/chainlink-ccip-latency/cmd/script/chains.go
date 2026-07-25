package main

// ccipChainSlug normalises CCIP's `sourceNetworkInfo.name` to the OCB
// canonical chain slug used across every other bench.
//
// CCIP uses a hierarchical naming convention that reflects the L1/L2
// relationship: L1s are `<chain>-mainnet` (ethereum-mainnet,
// polygon-mainnet, avalanche-mainnet) while L2s are
// `<parent>-mainnet-<child>-1` (ethereum-mainnet-base-1,
// ethereum-mainnet-arbitrum-1, bitcoin-mainnet-bitlayer-1). We
// enumerate both forms explicitly rather than parse the pattern —
// makes the mapping legible and the audit trail obvious when CCIP
// adds a new chain we didn't anticipate.
//
// Only mainnet entries are mapped; testnet rows are dropped in main.go
// via the `environment != "mainnet"` guard so we never emit test-chain
// latency.
//
// Fall-through in main.go emits `chain-<lowered>` for unknown names so
// the histogram flows under a synthetic label until we add the row here.
var ccipChainSlug = map[string]string{
	// L1s
	"ethereum-mainnet":              "ethereum",
	"solana-mainnet":                "solana",
	"binance_smart_chain-mainnet":   "bnb",
	"polygon-mainnet":               "polygon",
	"avalanche-mainnet":             "avalanche",
	"celo-mainnet":                  "celo",
	"gnosis-mainnet":                "gnosis",
	"fantom-mainnet":                "fantom",
	"metis-mainnet":                 "metis",
	"ronin-mainnet":                 "ronin",
	"soneium-mainnet":               "soneium",
	"monad-mainnet":                 "monad",
	"berachain-mainnet":             "berachain",
	"apechain-mainnet":              "apechain",
	"corn-mainnet":                  "corn",
	"sonic-mainnet":                 "sonic",
	"robinhood-mainnet":             "robinhood",
	"0g-mainnet":                    "chain-0g",
	"adi-mainnet":                   "chain-adi",

	// Ethereum L2s (hierarchical naming)
	"ethereum-mainnet-arbitrum-1":   "arbitrum",
	"ethereum-mainnet-base-1":       "base",
	"ethereum-mainnet-optimism-1":   "optimism",
	"ethereum-mainnet-ink-1":        "ink",
	"ethereum-mainnet-mantle-1":     "mantle",
	"ethereum-mainnet-scroll-1":     "scroll",
	"ethereum-mainnet-blast-1":      "blast",
	"ethereum-mainnet-linea-1":      "linea",
	"ethereum-mainnet-zksync-1":     "zksync",
	"ethereum-mainnet-world-1":      "world-chain",
	"ethereum-mainnet-unichain-1":   "unichain",
	"ethereum-mainnet-bob-1":        "bob",
	"ethereum-mainnet-kroma-1":      "kroma",

	// Bitcoin L2s
	"bitcoin-mainnet-bitlayer-1":    "bitlayer",

	// Polkadot parachains
	"polkadot-mainnet-astar":        "astar",
}
