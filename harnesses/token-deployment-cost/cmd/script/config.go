package main

import (
	"os"
	"time"
)

type ChainKind string

const (
	KindEVM      ChainKind = "evm"
	KindOPStack  ChainKind = "opstack"
	KindSolana   ChainKind = "solana"
	KindSui      ChainKind = "sui"
	KindAptos    ChainKind = "aptos"
	KindCosmos   ChainKind = "cosmos"
	KindCardano  ChainKind = "cardano"
	KindStellar  ChainKind = "stellar"
	KindAlgorand ChainKind = "algorand"
	KindTON      ChainKind = "ton"
	KindNear     ChainKind = "near"
	KindICP      ChainKind = "icp"
)

// ChainConfig describes one chain whose token-creation cost we sample.
//
// Slug is the chain identifier used as a Prometheus label
// (chain="ethereum"). MobulaSymbol is the asset ticker we pass to
// Mobula's `multi-data?symbols=...` endpoint to read the live USD price
// of the chain's native gas token (ETH, SOL, POL, NTRN, ...).
//
// For EVM/OPStack: RPCURL is the JSON-RPC endpoint, From is a non-zero
// placeholder sender used in eth_estimateGas to satisfy RPCs that reject
// from=0x0 (no balance is needed — we never include msg.value).
type ChainConfig struct {
	Slug         string
	Name         string
	Kind         ChainKind
	RPCURL       string
	MobulaSymbol string
	Layer        string // "l1" | "l2" | "appchain"
	From         string // EVM only
}

type Config struct {
	Chains       []ChainConfig
	Interval     time.Duration
	PriceRefresh time.Duration
	MobulaAPIKey string
}

func getenvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

const defaultFrom = "0x000000000000000000000000000000000000dEaD"

func loadConfig() *Config {
	return &Config{
		Interval:     5 * time.Minute,
		PriceRefresh: 5 * time.Minute,
		MobulaAPIKey: getenvDefault("MOBULA_API_KEY", ""),
		Chains: []ChainConfig{
			// Solana SPL token (mint account rent)
			{Slug: "solana", Name: "Solana", Kind: KindSolana, RPCURL: getenvDefault("RPC_SOLANA", "https://api.mainnet-beta.solana.com"), MobulaSymbol: "SOL", Layer: "l1"},

			// Sui / Aptos (move publish gas)
			// Sui public fullnodes dropped JSON-RPC (suix_getReferenceGasPrice
			// answers "deprecated"), so the reference gas price is read from
			// the GraphQL service.
			{Slug: "sui", Name: "Sui", Kind: KindSui, RPCURL: getenvDefault("GRAPHQL_SUI", "https://graphql.mainnet.sui.io/graphql"), MobulaSymbol: "SUI", Layer: "l1"},
			{Slug: "aptos", Name: "Aptos", Kind: KindAptos, RPCURL: getenvDefault("RPC_APTOS", "https://fullnode.mainnet.aptoslabs.com"), MobulaSymbol: "APT", Layer: "l1"},

			// Cosmos TokenFactory chains (LCD denom_creation_fee param)
			{Slug: "osmosis", Name: "Osmosis", Kind: KindCosmos, RPCURL: getenvDefault("LCD_OSMOSIS", "https://lcd.osmosis.zone"), MobulaSymbol: "OSMO", Layer: "appchain"},
			{Slug: "injective", Name: "Injective", Kind: KindCosmos, RPCURL: getenvDefault("LCD_INJECTIVE", "https://lcd.injective.network"), MobulaSymbol: "INJ", Layer: "appchain"},

			// Cardano (Koios) + Stellar (Horizon) — deterministic protocol-param formulas.
			{Slug: "cardano", Name: "Cardano", Kind: KindCardano, RPCURL: getenvDefault("KOIOS_URL", "https://api.koios.rest/api/v1"), MobulaSymbol: "ADA", Layer: "l1"},
			{Slug: "stellar", Name: "Stellar", Kind: KindStellar, RPCURL: getenvDefault("HORIZON_URL", "https://horizon.stellar.org"), MobulaSymbol: "XLM", Layer: "l1"},

			// Algorand ASA: algod suggested params + the per-asset min balance.
			{Slug: "algorand", Name: "Algorand", Kind: KindAlgorand, RPCURL: getenvDefault("ALGOD_URL", "https://mainnet-api.algonode.cloud"), MobulaSymbol: "ALGO", Layer: "l1"},
			// Gram (TON) jetton: live basechain config params from tonapi.
			// Mobula's TON symbol resolves to Tokamak Network; GRAM is the
			// chain's own coin ("Gram (prev. Toncoin)").
			{Slug: "gram", Name: "Gram", Kind: KindTON, RPCURL: getenvDefault("TONAPI_URL", "https://tonapi.io"), MobulaSymbol: "GRAM", Layer: "l1"},
			// NEAR: the tkn.near factory's live deposit quote + live gas price.
			// Comma-separated endpoints, tried in order (FastNEAR's free tier
			// answers 429 to a shared IP).
			{Slug: "near", Name: "NEAR", Kind: KindNear, RPCURL: getenvDefault("RPC_NEAR", "https://rpc.mainnet.near.org,https://near.drpc.org"), MobulaSymbol: "NEAR", Layer: "l1"},
			// Internet Computer: canister creation fee in cycles, converted at
			// the cycles minting canister's live ICP/XDR rate.
			{Slug: "icp", Name: "Internet Computer", Kind: KindICP, RPCURL: getenvDefault("IC_API_URL", "https://ic-api.internetcomputer.org"), MobulaSymbol: "ICP", Layer: "l1"},

			// EVM L1s: eth_estimateGas on the pinned OpenZeppelin ERC20 init
			// code (contracts/) x eth_gasPrice. L2s stay out: their real cost
			// includes an L1 data fee that eth_estimateGas does not report the
			// same way on every stack.
			{Slug: "ethereum", Name: "Ethereum", Kind: KindEVM, RPCURL: getenvDefault("RPC_ETHEREUM", "https://ethereum-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l1", From: defaultFrom},
			{Slug: "bnb", Name: "BNB Chain", Kind: KindEVM, RPCURL: getenvDefault("RPC_BNB", "https://bsc-rpc.publicnode.com"), MobulaSymbol: "BNB", Layer: "l1", From: defaultFrom},
			{Slug: "avalanche", Name: "Avalanche", Kind: KindEVM, RPCURL: getenvDefault("RPC_AVALANCHE", "https://avalanche-c-chain-rpc.publicnode.com"), MobulaSymbol: "AVAX", Layer: "l1", From: defaultFrom},
			{Slug: "polygon", Name: "Polygon PoS", Kind: KindEVM, RPCURL: getenvDefault("RPC_POLYGON", "https://polygon-bor-rpc.publicnode.com"), MobulaSymbol: "POL", Layer: "l1", From: defaultFrom},
			{Slug: "sei", Name: "Sei", Kind: KindEVM, RPCURL: getenvDefault("RPC_SEI", "https://evm-rpc.sei-apis.com"), MobulaSymbol: "SEI", Layer: "l1", From: defaultFrom},
			{Slug: "cronos", Name: "Cronos", Kind: KindEVM, RPCURL: getenvDefault("RPC_CRONOS", "https://evm.cronos.org"), MobulaSymbol: "CRO", Layer: "l1", From: defaultFrom},
			{Slug: "kaia", Name: "Kaia", Kind: KindEVM, RPCURL: getenvDefault("RPC_KAIA", "https://public-en.node.kaia.io"), MobulaSymbol: "KAIA", Layer: "l1", From: defaultFrom},
			{Slug: "somnia", Name: "Somnia", Kind: KindEVM, RPCURL: getenvDefault("RPC_SOMNIA", "https://api.infra.mainnet.somnia.network"), MobulaSymbol: "SOMI", Layer: "l1", From: defaultFrom},
		},
	}
}
