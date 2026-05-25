package main

import (
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Scrape cadence — 5 min is enough since validator APRs / commissions
// move on epoch timescales (~2 days on Solana, hours on Hyperliquid).
// Polling faster would burn upstream goodwill without changing rankings.
const scrapeInterval = 5 * time.Minute

// Initial HTTP timeout. Stakewiz occasionally takes ~10s for the full
// 3k-validator dump; 30s leaves plenty of headroom.
const httpTimeout = 30 * time.Second

// Top-N cap for Solana — there are ~3000 validators total but anything
// past the top 200 has tiny stake (<<1M SOL) and exposing all of them
// would explode Prometheus cardinality. Top-200 covers >95% of stake.
const solanaTopN = 200

// Endpoints. All overridable via env so we can repoint to a mirror or
// internal cache without a rebuild.
var (
	stakewizURL  = envDefault("VAL_ECON_STAKEWIZ_URL", "https://api.stakewiz.com/validators")
	jitoKobeURL  = envDefault("VAL_ECON_JITO_KOBE_URL", "https://kobe.mainnet.jito.network/api/v1/validators")
	hyperliqURL  = envDefault("VAL_ECON_HYPERLIQUID_URL", "https://api.hyperliquid.xyz/info")
	coingeckoURL = envDefault("VAL_ECON_COINGECKO_URL", "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")
)

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// medianBps returns the median of the input slice in basis points.
// Empty input returns 0. Copies the slice before sorting so callers
// don't have their data mutated underneath them.
func medianBps(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	cp := make([]float64, len(values))
	copy(cp, values)
	sort.Float64s(cp)
	n := len(cp)
	if n%2 == 1 {
		return cp[n/2]
	}
	return (cp[n/2-1] + cp[n/2]) / 2
}

// shortenName guards against label-cardinality blowups from validators
// using long emoji-laden names. 64 chars is plenty for Grafana display.
func shortenName(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 64 {
		return s[:64]
	}
	if s == "" {
		return "(unknown)"
	}
	return s
}

// pctToBps converts a fractional/decimal rate (0.0734) into basis points
// (734). Negative inputs are clamped to 0 — a negative APR is treated as
// a data-quality issue, not a real signal.
func pctToBps(rate float64) float64 {
	bps := rate * 10000
	if bps < 0 {
		return 0
	}
	return bps
}

// parseFloat is a tolerant wrapper used when upstreams stringify floats.
func parseFloat(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return v
}
