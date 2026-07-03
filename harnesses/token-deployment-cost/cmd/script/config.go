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
	_ = defaultFrom // kept for when EVM chains are re-enabled with real OZ v5 bytecode
	return &Config{
		Interval:     5 * time.Minute,
		PriceRefresh: 5 * time.Minute,
		MobulaAPIKey: getenvDefault("MOBULA_API_KEY", ""),
		Chains: []ChainConfig{
			// Solana SPL token (mint account rent)
			{Slug: "solana", Name: "Solana", Kind: KindSolana, RPCURL: getenvDefault("RPC_SOLANA", "https://api.mainnet-beta.solana.com"), MobulaSymbol: "SOL", Layer: "l1"},

			// Sui / Aptos (move publish gas)
			{Slug: "sui", Name: "Sui", Kind: KindSui, RPCURL: getenvDefault("RPC_SUI", "https://sui-rpc.publicnode.com"), MobulaSymbol: "SUI", Layer: "l1"},
			{Slug: "aptos", Name: "Aptos", Kind: KindAptos, RPCURL: getenvDefault("RPC_APTOS", "https://fullnode.mainnet.aptoslabs.com"), MobulaSymbol: "APT", Layer: "l1"},

			// Cosmos TokenFactory chains (LCD denom_creation_fee param)
			{Slug: "osmosis", Name: "Osmosis", Kind: KindCosmos, RPCURL: getenvDefault("LCD_OSMOSIS", "https://lcd.osmosis.zone"), MobulaSymbol: "OSMO", Layer: "appchain"},
			{Slug: "injective", Name: "Injective", Kind: KindCosmos, RPCURL: getenvDefault("LCD_INJECTIVE", "https://lcd.injective.network"), MobulaSymbol: "INJ", Layer: "appchain"},

			// Cardano (Koios) + Stellar (Horizon) — deterministic protocol-param formulas.
			{Slug: "cardano", Name: "Cardano", Kind: KindCardano, RPCURL: getenvDefault("KOIOS_URL", "https://api.koios.rest/api/v1"), MobulaSymbol: "ADA", Layer: "l1"},
			{Slug: "stellar", Name: "Stellar", Kind: KindStellar, RPCURL: getenvDefault("HORIZON_URL", "https://horizon.stellar.org"), MobulaSymbol: "XLM", Layer: "l1"},
		},
	}
}
