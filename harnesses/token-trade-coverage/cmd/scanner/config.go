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
	Tokens           []Token
	Capabilities     map[string]ProviderCapability // provider -> {chain -> supported}
	MeasurementWinMs int64                         // rolling window per measurement

	// Per-provider sub-sampling (respects free-tier quotas).
	// A provider only runs when `iteration % everyN == 0`. Default 1
	// means every sweep. Higher = sparser samples but preserves free-
	// tier point budget on providers with tight limits (Bitquery Free
	// gives 1000 points / month, so on the default 60-min cadence with
	// EveryN=6 we spend ≤ 960 points / month across 8 supported tokens).
	MobulaEveryN   int
	BitqueryEveryN int
	CodexEveryN    int

	// Page caps: bound the max pagination pages per provider per token
	// per sweep. Prevents runaway cursor loops on a single very-heavy
	// token from burning a whole sweep's quota.
	MobulaMaxPages   int
	BitqueryMaxRows  int // Bitquery has no cursor — this is the per-query row cap
	CodexMaxPages    int
}

// LoadConfig reads env, defaults + hardcoded reference token list.
// Reference tokens are chosen for meaningful trade activity so a
// coverage gap becomes visible; rotate them here when a listed token
// goes illiquid.
func LoadConfig() *Config {
	return &Config{
		// Base cadence: 60 min. Doubled from the initial 30-min value
		// after quota math on Bitquery's 1000-pt free plan (see
		// BitqueryEveryN below). 24 sweeps / day gives >= 12 samples per
		// (chain, token) per day for providers that run every sweep —
		// plenty for a stable p50 over 24h.
		SweepSec:         envInt("SWEEP_SEC", 3600),
		MetricsPort:      envStr("METRICS_PORT", "2112"),
		HTTPTimeoutSec:   envInt("HTTP_TIMEOUT_SEC", 30),
		MeasurementWinMs: int64(60*60) * 1000, // 60 min rolling window
		MobulaKey:        os.Getenv("MOBULA_API_KEY"),
		BitqueryKey:      os.Getenv("BITQUERY_API_KEY"),
		CodexKey:         os.Getenv("CODEX_API_KEY"),

		// Mobula: unlimited (own infra). Run every sweep.
		MobulaEveryN: envInt("MOBULA_EVERY_N", 1),
		// Bitquery Free: 1000 pts / month. At ~1-2 pts per
		// DEXTradeByTokens call and 8 supported tokens per sweep,
		// running every 6th sweep = 4 sweeps / day × 8 tokens × 30
		// days = 960 calls / month, well inside the free budget.
		// Bump to 1 if on the Developer plan ($99/mo, 500k pts).
		BitqueryEveryN: envInt("BITQUERY_EVERY_N", 6),
		// Codex Free: generous rate-based limits (no monthly point
		// cap on the current tier). Run every sweep.
		CodexEveryN: envInt("CODEX_EVERY_N", 1),

		// Page caps. A high-volume token that fires cursor-paginated
		// requests indefinitely can drain a monthly budget in one
		// sweep. These bound the worst case per token per sweep.
		MobulaMaxPages:  envInt("MOBULA_MAX_PAGES", 20),
		BitqueryMaxRows: envInt("BITQUERY_MAX_ROWS", 10000),
		CodexMaxPages:   envInt("CODEX_MAX_PAGES", 10),
		Tokens: []Token{
			// Reference tokens selected 2026-07-23 via a Mobula
			// `/api/2/trades/filters` sweep over the last hour, picking
			// mid-liquidity actives (not pure blue chips, so provider
			// coverage differences show; not pump.fun day-olds, so the
			// bench doesn't die if a specific token's activity dries up
			// tomorrow). All 10 verified > 50 trades / 1 h at pick time.
			// Rotate here when a listed token's volume drops off.
			//
			// Solana. BONK and WIF are both well past the pump.fun window
			// and trade across every Solana DEX indexed by the three
			// providers, which is what surfaces real coverage differences.
			{Chain: "solana", Address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", Symbol: "BONK"},
			{Chain: "solana", Address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", Symbol: "WIF"},
			// Ethereum. PEPE covers the top of the meme distribution;
			// MOG sits mid-liquidity and often reveals per-DEX gaps that
			// PEPE's wall-to-wall coverage masks.
			{Chain: "ethereum", Address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", Symbol: "PEPE"},
			{Chain: "ethereum", Address: "0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a", Symbol: "MOG"},
			// BSC. CAKE is the anchor (own PancakeSwap listings); FLOKI
			// trades across PancakeSwap + long-tail BEP-20 AMMs so the
			// per-DEX split shows.
			{Chain: "bsc", Address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", Symbol: "CAKE"},
			{Chain: "bsc", Address: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E", Symbol: "FLOKI"},
			// Base. BRETT and DEGEN — top two active memes on Aerodrome
			// + Uniswap v3, wide enough coverage on Base that they're
			// stable picks across weeks.
			{Chain: "base", Address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", Symbol: "BRETT"},
			{Chain: "base", Address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", Symbol: "DEGEN"},
			// Stellar. yXLM (wrapped XLM) and SHX (Stronghold) are both
			// high-activity Stellar-native assets. Address format is
			// Stellar's canonical `<code>:<issuer>` string — Mobula
			// accepts that directly as `tokenAddress`.
			{Chain: "stellar", Address: "yXLM:GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55", Symbol: "yXLM"},
			{Chain: "stellar", Address: "SHX:GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH", Symbol: "SHX"},
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
