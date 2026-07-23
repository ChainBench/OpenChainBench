package main

import (
	"os"
	"strconv"
	"time"
)

// Token is a reference token watched for coverage measurement.
type Token struct {
	Chain   string // "solana", "ethereum", "bsc", "base", "stellar"
	Address string // native address on that chain
	Symbol  string // short label for logs
}

// ProviderCapability declares which chains a provider is measured on.
// A provider is EXCLUDED from a chain's row if the chain is not listed
// here; that keeps the leaderboard honest instead of counting a
// non-integration as a zero-score defeat.
type ProviderCapability map[string]bool

// Config is populated once at startup and read-only afterwards.
type Config struct {
	SweepSec         int
	MetricsPort      string
	HTTPTimeoutSec   int
	MobulaKey        string
	BitqueryKey      string
	CodexKey         string
	MoralisKey       string
	Tokens           []Token
	Capabilities     map[string]ProviderCapability // provider -> {chain -> supported}
	MeasurementWinMs int64                         // rolling window per measurement
}

// LoadConfig reads env, defaults + hardcoded reference token list.
// Reference tokens are chosen for meaningful trade activity so a
// coverage gap becomes visible; rotate them here when a listed token
// goes illiquid.
func LoadConfig() *Config {
	return &Config{
		SweepSec:         envInt("SWEEP_SEC", 1800),
		MetricsPort:      envStr("METRICS_PORT", "2112"),
		HTTPTimeoutSec:   envInt("HTTP_TIMEOUT_SEC", 30),
		MeasurementWinMs: int64(60*60) * 1000, // 60 min rolling window
		MobulaKey:        os.Getenv("MOBULA_API_KEY"),
		BitqueryKey:      os.Getenv("BITQUERY_API_KEY"),
		CodexKey:         os.Getenv("CODEX_API_KEY"),
		MoralisKey:       os.Getenv("MORALIS_API_KEY"),
		Tokens: []Token{
			// Solana. Pump.fun-era memes with high trade frequency across
			// multiple DEXs so any provider indexing only one venue drops
			// visibly in capture rate. Rotated when activity dies out.
			{Chain: "solana", Address: "BWJ7zJauzatao4FsBnGdVsqdBi3k5NbgSY62noZApump", Symbol: "NANA"},
			{Chain: "solana", Address: "GJqCjtgEwqdFWVRsDs8JXKFoTeRVZeHs1RL4ccvrpump", Symbol: "OILINU"},
			// Ethereum. Active meme + real-utility pairs so the Ethereum
			// row isn't dominated by a single AMM.
			{Chain: "ethereum", Address: "0x279B46A5BCB1D1de37F5588e46c756B15b26A896", Symbol: "OIL"},
			{Chain: "ethereum", Address: "0x2b566950BA2298AcEf3c730CC0129b2f4fBd30a3", Symbol: "KIMCHI"},
			// BSC. High-volume PancakeSwap tokens.
			{Chain: "bsc", Address: "0xc20E45E49e0E79f0fC81E71F05fD2772d6587777", Symbol: "MILADY"},
			{Chain: "bsc", Address: "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D", Symbol: "ARK"},
			// Base. Aerodrome + Uniswap v3 v4 anchors.
			{Chain: "base", Address: "0x64384EBd580f8c48ED4972bbbE895aDE55671Aca", Symbol: "BROKE"},
			{Chain: "base", Address: "0x9aA448c1Da3B8975e0619A5a96db4Fccc491e4d5", Symbol: "LANCER"},
			// Stellar. Populate with active issuer:asset codes once Mobula
			// confirms the addresses. Placeholder rows are skipped by the
			// harness (empty address = skip).
			{Chain: "stellar", Address: "", Symbol: "STELLAR-1"},
			{Chain: "stellar", Address: "", Symbol: "STELLAR-2"},
		},
		Capabilities: map[string]ProviderCapability{
			"mobula": {
				"solana": true, "ethereum": true, "bsc": true, "base": true, "stellar": true,
			},
			"bitquery": {
				"solana": true, "ethereum": true, "bsc": true, "base": true,
			},
			"codex": {
				"solana": true, "ethereum": true, "bsc": true, "base": true,
			},
			"moralis": {
				"solana": true, "ethereum": true, "bsc": true, "base": true,
			},
		},
	}
}

func (c *Config) HTTPTimeout() time.Duration {
	return time.Duration(c.HTTPTimeoutSec) * time.Second
}

// Supports reports whether the (provider, chain) pair is measured.
func (c *Config) Supports(provider, chain string) bool {
	caps, ok := c.Capabilities[provider]
	if !ok {
		return false
	}
	return caps[chain]
}

func envInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func envStr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
