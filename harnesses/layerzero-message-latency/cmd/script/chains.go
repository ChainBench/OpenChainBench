package main

// lzChainSlug normalises LayerZero's `pathway.sender.chain` (kebab-cased
// human name: `ethereum`, `bsc`, `base`, `arbitrum`, `solana`, …) to
// the OCB canonical chain slug used across every other bench.
//
// LayerZero's naming is mostly already our canonical form (great luck);
// only a few divergences need explicit mapping:
//   - `bsc` → `bnb` (we use the token symbol convention across the site)
//   - LayerZero exposes a bunch of exotic chains (orderly, flare, ape,
//     robinhood, hyperliquid) that map to our slugs where they exist.
//
// Unknown names fall through to a synthetic `chain-<lowered>` slug in
// main.go so we never drop data silently.
var lzChainSlug = map[string]string{
	"ethereum":    "ethereum",
	"solana":      "solana",
	"bsc":         "bnb",
	"polygon":     "polygon",
	"avalanche":   "avalanche",
	"arbitrum":    "arbitrum",
	"optimism":    "optimism",
	"base":        "base",
	"linea":       "linea",
	"scroll":      "scroll",
	"blast":       "blast",
	"mantle":      "mantle",
	"celo":        "celo",
	"gnosis":      "gnosis",
	"fantom":      "fantom",
	"tron":        "tron",
	"metis":       "metis",
	"moonbeam":    "moonbeam",
	"kaia":        "kaia",
	"aurora":      "aurora",
	"cronos":      "cronos",
	"fraxtal":     "fraxtal",
	"zksync":      "zksync",
	"taiko":       "taiko",
	"soneium":     "soneium",
	"unichain":    "unichain",
	"world":       "world-chain",
	"berachain":   "berachain",
	"sonic":       "sonic",
	"monad":       "monad",
	"ink":         "ink",
	"opbnb":       "opbnb",
	"hyperliquid": "hyperliquid",
	"robinhood":   "robinhood",
	"sui":         "sui",
	"aptos":       "aptos",
	"injective":   "injective",
	"sei":         "sei",
	// LayerZero-native / exotic chains — kept under their own slug so
	// they show up as distinct rows rather than under `chain-<name>`
	// which reads worse.
	"orderly":  "chain-orderly",
	"flare":    "chain-flare",
	"ape":      "chain-ape",
	"telos":    "chain-telos",
	"zircuit":  "chain-zircuit",
	"story":    "chain-story",
	"bob":      "bob",
	"kroma":    "kroma",
	"astar":    "astar",
	"apechain": "apechain",
}
