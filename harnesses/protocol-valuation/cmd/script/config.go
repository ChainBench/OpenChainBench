package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	// DeFiLlama's fee series is daily and CoinGecko's free tier is
	// rate-limited, so a faster tick spends requests re-reading numbers
	// that have not moved.
	RefreshInterval time.Duration

	// Floor on trailing 30d fees. Below it the annualized denominator is
	// small enough that a rounding difference in one day's adapter output
	// moves the ratio by a multiple.
	MinFees30dUSD float64

	// Floor on circulating supply as a percent of total. A P/F computed on
	// a 4 %-float token divides a market cap that barely exists by real
	// fees and prints a number near zero, which then leads an ascending
	// board. The measured cohort had six such rows in the top twelve
	// before this floor (2026-09-23).
	MinFloatPct float64
}

func loadConfig() *Config {
	c := &Config{
		RefreshInterval: 60 * time.Minute,
		MinFees30dUSD:   100_000,
		MinFloatPct:     10,
	}
	if v := os.Getenv("REFRESH_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.RefreshInterval = time.Duration(n) * time.Minute
		}
	}
	if v := os.Getenv("MIN_FEES_30D_USD"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
			c.MinFees30dUSD = n
		}
	}
	if v := os.Getenv("MIN_FLOAT_PCT"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n >= 0 {
			c.MinFloatPct = n
		}
	}
	fmt.Printf("config: every=%v, min_fees_30d=$%.0fk, min_float=%.0f%%, min_peer_group=%d\n",
		c.RefreshInterval, c.MinFees30dUSD/1000, c.MinFloatPct, MinPeerGroup)
	return c
}
