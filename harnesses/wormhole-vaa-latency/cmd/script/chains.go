package main

// emitterChainSlug maps Wormhole's numeric emitter-chain id to the site's
// chain slug. Only chains with non-trivial VAA volume are enumerated —
// unrecognised chains fall through to a synthetic "chain<id>" slug in
// main.go so the harness never drops a sample silently.
//
// Source: https://docs.wormhole.com/wormhole/reference/blockchain-ids
// (kept manually short — Wormhole periodically adds new chain ids and
// we only want to surface chains that (a) have public infrastructure
// and (b) are already tracked elsewhere on the site.)
var emitterChainSlug = map[int]string{
	1:  "solana",
	2:  "ethereum",
	4:  "bnb",
	5:  "polygon",
	6:  "avalanche",
	10: "fantom",
	14: "celo",
	15: "near",
	16: "moonbeam",
	19: "injective",
	21: "sui",
	22: "aptos",
	23: "arbitrum",
	24: "optimism",
	30: "base",
	32: "sei",
	34: "scroll",
	35: "mantle",
	38: "linea",
	39: "berachain",
	44: "unichain",
	45: "world-chain",
	48: "monad",
	50: "ink",
}
