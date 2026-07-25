package main

import "strings"

// axelarChainSlug normalises Axelar's `call.chain` and
// `returnValues.destinationChain` to OCB canonical chain slugs.
//
// Axelar's naming quirks:
//   - `binance` = BNB Chain (Axelar's historical name)
//   - source chain names are lowercase; destination chain names can be
//     Title case (`Polygon`, `Base`, ...) depending on the API path
//   - `axelar` is Axelar's own Cosmos chain, kept as a first-class row
//     because messages can originate there too
//   - Cosmos chains (osmosis, injective, sei, celestia, kava) are
//     Axelar-exclusive coverage vs Wormhole/LayerZero/CCIP/Hyperlane
//
// Unknown names fall through to `chain-<lowered>` so we never drop data.
var axelarChainSlug = map[string]string{
	// EVM L1s
	"ethereum":   "ethereum",
	"binance":    "bnb",
	"polygon":    "polygon",
	"avalanche":  "avalanche",
	"fantom":     "fantom",
	"moonbeam":   "moonbeam",
	"celo":       "celo",
	// EVM L2s
	"arbitrum":   "arbitrum",
	"optimism":   "optimism",
	"base":       "base",
	"linea":      "linea",
	"scroll":     "scroll",
	"blast":      "blast",
	"mantle":     "mantle",
	"fraxtal":    "fraxtal",
	// Cosmos (Axelar-exclusive vs the other 3 protocols)
	"axelarnet":  "axelar",
	"axelar":     "axelar",
	"osmosis":    "osmosis",
	"injective":  "injective",
	"sei":        "sei",
	"celestia":   "celestia",
	"kava":       "kava",
	"kujira":     "kujira",
	"stargaze":   "stargaze",
	"neutron":    "neutron",
	"cosmoshub":  "cosmos-hub",
	"comdex":     "comdex",
	"crescent":   "crescent",
	"secret":     "secret",
	"terra":      "terra",
	"terra-2":    "terra-2",
	"agoric":     "agoric",
	"evmos":      "evmos",
	"stride":     "stride",
	"regen":      "regen",
	"umee":       "umee",
	"acre":       "acre",
	"ojo":        "ojo",
	"assetmantle": "assetmantle",
	"aura":       "aura",
	"jackal":     "jackal",
	"provenance": "provenance",
	"xpla":       "xpla",
	"c4e":        "c4e",
	"rebus":      "rebus",
	"lava":       "lava",
	"nolus":      "nolus",
	"quicksilver": "quicksilver",
	"impacthub":  "impacthub",
}

// canonicalizeAxelarChain lowercases + looks up. Unknowns get
// `chain-<lowered>` so labels stay stable across polls.
func canonicalizeAxelarChain(name string) string {
	if name == "" {
		return "unknown"
	}
	low := strings.ToLower(name)
	if s, ok := axelarChainSlug[low]; ok {
		return s
	}
	return "chain-" + low
}
