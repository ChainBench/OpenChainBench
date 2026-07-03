package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds runtime knobs for the perp-cohort-stats harness.
//
// The harness is intentionally single-knob (one tick interval) because
// every per-venue cohort metric is published on the same cadence. The
// per-source HTTP timeout is fixed at 15s in adapter.go to keep the
// sweep wall-clock bounded.
type Config struct {
	// TickInterval is how often the full source sweep runs. Default 60s.
	// Override with TICK_INTERVAL_SECONDS. The per-tick request load is:
	//   - 3 x Mobula funding (one per asset BTC/ETH/SOL)
	//   - 1 x Hyperliquid info POST
	//   - 2 x Lighter native (exchangeStats + orderBookDetails)
	//   - 3 x DefiLlama HTML (one per venue)
	//   ~= 9 requests/tick across 4 hosts, comfortably polite.
	TickInterval time.Duration

	// MobulaAPIKey is the Authorization header value for api.mobula.io.
	// Must be supplied via the MOBULA_API_KEY env var. When empty, the
	// two Mobula-backed sources are skipped entirely (the rest of the
	// cohort sweep keeps running on native + DefiLlama sources).
	MobulaAPIKey string

	// MobulaFundingVenues is the comma-separated `exchange` query value
	// sent to /api/1/market/cefi/funding-rate. The default covers the
	// 12-venue OCB perp cohort. Each call returns one row per venue per
	// asset, so 3 asset calls cover the full BTC/ETH/SOL/12-venue grid.
	MobulaFundingVenues string
}

func loadConfig() *Config {
	c := &Config{
		TickInterval:        60 * time.Second,
		MobulaAPIKey:        "",
		MobulaFundingVenues: "binance,bybit,okx,hyperliquid,gate,lighter,kucoin,mexc,bitget,kraken,coinbase,deribit",
	}

	if v := os.Getenv("TICK_INTERVAL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.TickInterval = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("MOBULA_API_KEY"); v != "" {
		c.MobulaAPIKey = v
	}
	if v := os.Getenv("MOBULA_FUNDING_VENUES"); v != "" {
		c.MobulaFundingVenues = v
	}

	if c.MobulaAPIKey == "" {
		fmt.Println("[config] WARN: MOBULA_API_KEY is unset; Mobula funding + Mobula pairs sources will be skipped this run.")
	}

	fmt.Printf("Config: venues=%d, tick=%v, mobula_venues=%q, mobula_key=%s\n",
		len(Registry), c.TickInterval, c.MobulaFundingVenues, maskedKey(c.MobulaAPIKey))
	return c
}

// maskedKey renders the Mobula key as e.g. "cb08****d689" so the boot
// log proves the key is loaded without leaking the value to stdout.
func maskedKey(k string) string {
	if k == "" {
		return "<empty>"
	}
	if len(k) < 8 {
		return "****"
	}
	return k[:4] + "****" + k[len(k)-4:]
}
