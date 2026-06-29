package main

import (
	"os"
	"time"
)

type ChainKind string

const (
	KindEVM     ChainKind = "evm"
	KindOPStack ChainKind = "opstack"
	KindSolana  ChainKind = "solana"
	KindSui     ChainKind = "sui"
	KindAptos   ChainKind = "aptos"
	KindCosmos  ChainKind = "cosmos"
	KindCardano ChainKind = "cardano"
	KindStellar ChainKind = "stellar"
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
	from := defaultFrom
	return &Config{
		Interval:     5 * time.Minute,
		PriceRefresh: 5 * time.Minute,
		MobulaAPIKey: getenvDefault("MOBULA_API_KEY", ""),
		Chains: []ChainConfig{
			// EVM L1
			{Slug: "ethereum", Name: "Ethereum", Kind: KindEVM, RPCURL: getenvDefault("RPC_ETHEREUM", "https://ethereum-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l1", From: from},
			{Slug: "bnb", Name: "BNB Chain", Kind: KindEVM, RPCURL: getenvDefault("RPC_BNB", "https://bsc-rpc.publicnode.com"), MobulaSymbol: "BNB", Layer: "l1", From: from},
			{Slug: "avalanche", Name: "Avalanche", Kind: KindEVM, RPCURL: getenvDefault("RPC_AVALANCHE", "https://avalanche-c-chain-rpc.publicnode.com"), MobulaSymbol: "AVAX", Layer: "l1", From: from},
			{Slug: "polygon", Name: "Polygon", Kind: KindEVM, RPCURL: getenvDefault("RPC_POLYGON", "https://polygon-bor-rpc.publicnode.com"), MobulaSymbol: "POL", Layer: "l1", From: from},

			// EVM L2 (OP Stack: needs L1-fee oracle add-on)
			{Slug: "optimism", Name: "Optimism", Kind: KindOPStack, RPCURL: getenvDefault("RPC_OPTIMISM", "https://optimism-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l2", From: from},
			{Slug: "base", Name: "Base", Kind: KindOPStack, RPCURL: getenvDefault("RPC_BASE", "https://base-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l2", From: from},
			{Slug: "blast", Name: "Blast", Kind: KindOPStack, RPCURL: getenvDefault("RPC_BLAST", "https://blast-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l2", From: from},
			{Slug: "mantle", Name: "Mantle", Kind: KindOPStack, RPCURL: getenvDefault("RPC_MANTLE", "https://mantle-rpc.publicnode.com"), MobulaSymbol: "MNT", Layer: "l2", From: from},
			{Slug: "opbnb", Name: "opBNB", Kind: KindOPStack, RPCURL: getenvDefault("RPC_OPBNB", "https://opbnb-rpc.publicnode.com"), MobulaSymbol: "BNB", Layer: "l2", From: from},
			{Slug: "celo", Name: "Celo", Kind: KindOPStack, RPCURL: getenvDefault("RPC_CELO", "https://celo-rpc.publicnode.com"), MobulaSymbol: "CELO", Layer: "l2", From: from},

			// EVM L2 / rollups (Arbitrum Nitro bakes L1 cost into eth_estimateGas → KindEVM works)
			{Slug: "arbitrum", Name: "Arbitrum", Kind: KindEVM, RPCURL: getenvDefault("RPC_ARBITRUM", "https://arbitrum-one-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l2", From: from},
			{Slug: "scroll", Name: "Scroll", Kind: KindEVM, RPCURL: getenvDefault("RPC_SCROLL", "https://scroll-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l2", From: from},
			{Slug: "linea", Name: "Linea", Kind: KindEVM, RPCURL: getenvDefault("RPC_LINEA", "https://linea-rpc.publicnode.com"), MobulaSymbol: "ETH", Layer: "l2", From: from},

			// Solana SPL token (mint account rent)
			{Slug: "solana", Name: "Solana", Kind: KindSolana, RPCURL: getenvDefault("RPC_SOLANA", "https://api.mainnet-beta.solana.com"), MobulaSymbol: "SOL", Layer: "l1"},

			// Sui / Aptos (move publish gas)
			{Slug: "sui", Name: "Sui", Kind: KindSui, RPCURL: getenvDefault("RPC_SUI", "https://sui-rpc.publicnode.com"), MobulaSymbol: "SUI", Layer: "l1"},
			{Slug: "aptos", Name: "Aptos", Kind: KindAptos, RPCURL: getenvDefault("RPC_APTOS", "https://fullnode.mainnet.aptoslabs.com"), MobulaSymbol: "APT", Layer: "l1"},

			// Cosmos TokenFactory chains (LCD denom_creation_fee param)
			{Slug: "osmosis", Name: "Osmosis", Kind: KindCosmos, RPCURL: getenvDefault("LCD_OSMOSIS", "https://lcd.osmosis.zone"), MobulaSymbol: "OSMO", Layer: "appchain"},
			{Slug: "injective", Name: "Injective", Kind: KindCosmos, RPCURL: getenvDefault("LCD_INJECTIVE", "https://lcd.injective.network"), MobulaSymbol: "INJ", Layer: "appchain"},
			{Slug: "neutron", Name: "Neutron", Kind: KindCosmos, RPCURL: getenvDefault("LCD_NEUTRON", "https://neutron-rest.publicnode.com"), MobulaSymbol: "NTRN", Layer: "appchain"},

			// Cardano (Koios) + Stellar (Horizon) — deterministic protocol-param formulas.
			{Slug: "cardano", Name: "Cardano", Kind: KindCardano, RPCURL: getenvDefault("KOIOS_URL", "https://api.koios.rest/api/v1"), MobulaSymbol: "ADA", Layer: "l1"},
			{Slug: "stellar", Name: "Stellar", Kind: KindStellar, RPCURL: getenvDefault("HORIZON_URL", "https://horizon.stellar.org"), MobulaSymbol: "XLM", Layer: "l1"},
		},
	}
}
