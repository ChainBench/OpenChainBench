package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds runtime knobs. Set via env vars on Railway.
type Config struct {
	// Mobula REST key. Required for /market/data and /market/blockchain/stats
	// (both endpoints rate-limit free traffic to ~10 req/min, the key lifts
	// that to a level that comfortably absorbs 21 chains × 2 endpoints
	// every refresh tick.) Without a key, Mobula returns 429 immediately.
	MobulaAPIKey string

	// How often DefiLlama is polled per chain. 15 min is the conservative
	// default: their public API is generous but the TVL value barely moves
	// inside a 15-min window (intra-day deltas are noise vs the day-over-
	// day signal we surface on the chain page). 3 calls/h × 21 chains = 63
	// req/h, well under any sane rate-limit ceiling.
	DefillamaRefreshInterval time.Duration

	// Mobula tick. Faster because we own the source — and native-token
	// prices move on shorter cycles than DEX-TVL aggregates. 5 min keeps
	// the price card fresh without hammering. 12 calls/h × 21 chains × 2
	// endpoints = 504 req/h, fine on a paid key.
	MobulaRefreshInterval time.Duration
}

func loadConfig() *Config {
	c := &Config{
		MobulaAPIKey:             os.Getenv("MOBULA_API_KEY"),
		DefillamaRefreshInterval: 15 * time.Minute,
		MobulaRefreshInterval:    5 * time.Minute,
	}

	if v := os.Getenv("DEFILLAMA_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.DefillamaRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("MOBULA_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.MobulaRefreshInterval = time.Duration(n) * time.Minute
		}
	}

	fmt.Printf("Config: chains=%d, defillama_every=%v, mobula_every=%v, mobula_key=%v\n",
		len(Registry), c.DefillamaRefreshInterval, c.MobulaRefreshInterval, c.MobulaAPIKey != "")
	return c
}
