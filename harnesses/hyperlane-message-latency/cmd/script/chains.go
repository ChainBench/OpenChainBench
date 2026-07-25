package main

// hyperlaneChainSlug maps Hyperlane's `origin_chain_id` / `destination_chain_id`
// (numeric) to the OCB canonical chain slug.
//
// For EVM chains, the id equals the standard EVM chainId; for non-EVM
// chains, Hyperlane assigns arbitrary domain IDs (Solana =
// 1264145989, Sui = 101, etc.). We enumerate all mainnet Hyperlane
// deployments here.
//
// Unknown ids fall through to a synthetic `chain-<id>` slug so we
// never drop data — new deployments show up as their own row until
// we add the mapping.
var hyperlaneChainSlug = map[int]string{
	// EVM L1s (standard chainIds)
	1:     "ethereum",
	56:    "bnb",
	137:   "polygon",
	43114: "avalanche",
	100:   "gnosis",
	42161: "arbitrum",
	10:    "optimism",
	8453:  "base",
	59144: "linea",
	324:   "zksync",
	534352: "scroll",
	81457: "blast",
	5000:  "mantle",
	42220: "celo",
	1101:  "polygon-zkevm",
	7777777: "zora",
	480:   "world-chain",
	130:   "unichain",
	60808: "bob",
	57073: "ink",
	1868:  "soneium",
	146:   "sonic",
	80094: "berachain",
	33139: "apechain",
	21000000: "corn",
	// Ronin
	2020: "ronin",
	// Fraxtal
	252: "fraxtal",
	// Moonbeam
	1284: "moonbeam",
	// Astar EVM
	592: "astar",
	// Metis
	1088: "metis",
	// Manta Pacific
	169: "manta",
	// Kaia (ex-Klaytn)
	8217: "kaia",

	// Non-EVM (Hyperlane domain IDs, verified live via API sample)
	1264145989: "solana",
	1399811149: "solana", // Alt Solana domain id (Wormhole convention) seen in some rows
	// Rome / Roman-Storage chain
	173: "chain-rome",
	// Sui, Aptos, etc. Add as they gain traction.
}
