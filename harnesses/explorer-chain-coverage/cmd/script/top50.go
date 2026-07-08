package main

// top50 is the pinned list of the 50 most economically active
// mainnets (blend of DefiLlama TVL, daily fees and tx activity,
// L2Beat cross-checked, snapshot 2026-07-06). It powers the
// anti-inflation column: raw chain counts reward hosting ghost
// rollups, "top-50 covered" answers what integrators actually ask
// ("does it cover MY chains?"). Refresh quarterly by re-pulling
// api.llama.fi/v2/chains; keep 50 entries exactly.
//
// evmID is 0 for non-EVM chains; aliases are normalized (lowercase
// alphanumerics) names used to match non-EVM chains across explorer
// namespaces (Blockchair keys, OKLink shortnames, ...).
type topChain struct {
	name    string
	evmID   int64
	aliases []string
}

var top50 = []topChain{
	{"Ethereum", 1, []string{"ethereum", "eth"}},
	{"Solana", 0, []string{"solana", "sol"}},
	{"BNB Smart Chain", 56, []string{"bnbsmartchain", "bsc", "bnb"}},
	{"Tron", 0, []string{"tron", "trx"}},
	{"Base", 8453, []string{"base"}},
	{"Bitcoin", 0, []string{"bitcoin", "btc"}},
	{"HyperEVM", 999, []string{"hyperevm", "hyperliquid"}},
	{"Arbitrum One", 42161, []string{"arbitrumone", "arbitrum"}},
	{"Polygon PoS", 137, []string{"polygonpos", "polygon", "matic"}},
	{"Plasma", 9745, []string{"plasma"}},
	{"Monad", 143, []string{"monad"}},
	{"Avalanche C-Chain", 43114, []string{"avalanchecchain", "avalanche", "avax"}},
	{"Sui", 0, []string{"sui"}},
	{"OP Mainnet", 10, []string{"opmainnet", "optimism"}},
	{"Cronos", 25, []string{"cronos", "cro"}},
	{"Stellar", 0, []string{"stellar", "xlm"}},
	{"Starknet", 0, []string{"starknet"}},
	{"NEAR", 0, []string{"near"}},
	{"Mantle", 5000, []string{"mantle"}},
	{"Ink", 57073, []string{"ink"}},
	{"Flare", 14, []string{"flare"}},
	{"Aptos", 0, []string{"aptos", "apt"}},
	{"Rootstock", 30, []string{"rootstock", "rsk"}},
	{"Gnosis Chain", 100, []string{"gnosischain", "gnosis", "xdai"}},
	{"dYdX Chain", 0, []string{"dydxchain", "dydx"}},
	{"X Layer", 196, []string{"xlayer", "okb"}},
	{"Cardano", 0, []string{"cardano", "ada"}},
	{"MegaETH", 4326, []string{"megaeth"}},
	{"Stacks", 0, []string{"stacks", "stx"}},
	{"Katana", 747474, []string{"katana"}},
	{"TON", 0, []string{"ton", "theopennetwork"}},
	{"Berachain", 80094, []string{"berachain", "bera"}},
	{"Sei", 1329, []string{"sei"}},
	{"PulseChain", 369, []string{"pulsechain", "pls"}},
	{"Hedera", 295, []string{"hedera", "hbar"}},
	{"XRP Ledger", 0, []string{"xrpledger", "xrpl", "xrp", "ripple"}},
	{"Algorand", 0, []string{"algorand", "algo"}},
	{"World Chain", 480, []string{"worldchain", "world"}},
	{"Linea", 59144, []string{"linea"}},
	{"Unichain", 130, []string{"unichain"}},
	{"Celo", 42220, []string{"celo"}},
	{"Sonic", 146, []string{"sonic"}},
	{"ZKsync Era", 324, []string{"zksyncera", "zksync"}},
	{"Internet Computer", 0, []string{"internetcomputer", "icp"}},
	{"Scroll", 534352, []string{"scroll"}},
	{"Ronin", 2020, []string{"ronin"}},
	{"Injective", 0, []string{"injective", "inj"}},
	{"Filecoin", 314, []string{"filecoin", "fil"}},
	{"Litecoin", 0, []string{"litecoin", "ltc"}},
	{"Dogecoin", 0, []string{"dogecoin", "doge"}},
}

// top50Count returns how many top-50 chains are present in the given
// live sets: evmLive keyed by EVM chain id, nameLive keyed by
// normalized chain name/alias.
func top50Count(evmLive map[int64]bool, nameLive map[string]bool) int {
	n := 0
	for _, c := range top50 {
		if c.evmID != 0 && evmLive[c.evmID] {
			n++
			continue
		}
		hit := false
		for _, a := range c.aliases {
			if nameLive[a] {
				hit = true
				break
			}
		}
		if hit {
			n++
		}
	}
	return n
}

// normalizeChainName lowercases and strips non-alphanumerics, same
// convention as the portfolio harness.
func normalizeChainName(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out = append(out, r)
		case r >= 'A' && r <= 'Z':
			out = append(out, r+32)
		}
	}
	return string(out)
}
