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
	// that to a level that comfortably absorbs 32 chains × 2 endpoints
	// every refresh tick.) Without a key, Mobula returns 429 immediately.
	MobulaAPIKey string

	// How often DefiLlama is polled per chain. 15 min is the conservative
	// default: their public API is generous but the TVL value barely moves
	// inside a 15-min window (intra-day deltas are noise vs the day-over-
	// day signal we surface on the chain page). 4 ticks/h × the DefiLlama-mapped
	// chains × 3 endpoints = 372 req/h, well under any sane rate-limit
	// ceiling.
	DefillamaRefreshInterval time.Duration

	// Mobula tick. Faster because we own the source — and native-token
	// prices move on shorter cycles than DEX-TVL aggregates. 5 min keeps
	// the price card fresh without hammering. Native calls dedup by
	// symbol, so one tick is a request per unique native symbol plus one per Mobula-mapped chain, under
	// 600 req/h, fine on a paid key.
	MobulaRefreshInterval time.Duration

	// L2Beat tick. One unauthenticated request per tick covers the whole
	// cohort (~280 KB), so 15 min costs 4 req/h in total, not per chain.
	// Matched to the DefiLlama cadence because the two feed the same
	// cards and a reader comparing TVL with value secured should not be
	// comparing two different instants.
	L2BeatRefreshInterval time.Duration

	// Chain fees tick. Two requests per DefiLlama-mapped chain, and the
	// figures move once a day on DefiLlama's day close, so hourly is
	// plenty: 38 chains x 2 = 76 requests an hour.
	ChainFeesRefreshInterval time.Duration

	// Size floor for the cohort the 7-day median is taken over. The median
	// is a yardstick, and a yardstick that lets $2M chains vote moves on
	// one airdrop. $200M keeps the cohort to chains whose weekly move is
	// capital rotating rather than a single incentive program.
	L2BeatMedianFloorUSD float64
}

func loadConfig() *Config {
	c := &Config{
		MobulaAPIKey:             os.Getenv("MOBULA_API_KEY"),
		DefillamaRefreshInterval: 15 * time.Minute,
		MobulaRefreshInterval:    5 * time.Minute,
		L2BeatRefreshInterval:    15 * time.Minute,
		ChainFeesRefreshInterval: 60 * time.Minute,
		L2BeatMedianFloorUSD:     200e6,
	}
	if v := os.Getenv("CHAIN_FEES_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.ChainFeesRefreshInterval = time.Duration(n) * time.Minute
		}
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

	if v := os.Getenv("L2BEAT_REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.L2BeatRefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("L2BEAT_MEDIAN_FLOOR_USD"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
			c.L2BeatMedianFloorUSD = n
		}
	}

	rollups := 0
	for _, ch := range Registry {
		if ch.L2Beat != "" {
			rollups++
		}
	}

	fmt.Printf("Config: chains=%d (%d with an L2Beat id), defillama_every=%v, mobula_every=%v, l2beat_every=%v, fees_every=%v, l2beat_floor=$%.0fM, mobula_key=%v\n",
		len(Registry), rollups, c.DefillamaRefreshInterval, c.MobulaRefreshInterval,
		c.L2BeatRefreshInterval, c.ChainFeesRefreshInterval, c.L2BeatMedianFloorUSD/1e6, c.MobulaAPIKey != "")
	return c
}
