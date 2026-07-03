package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds runtime knobs for the perp-execution-scanner harness.
//
// The scanner tracks a small hard-coded list of (asset, venue) pairs and
// walks the orderbook at every SizeBucket, both sides. Cardinality is
// intentionally low (2 venues x 8 sizes x 2 sides = 32 slippage series
// per asset today) so a 30s tick is comfortable.
type Config struct {
	TickInterval time.Duration
	ListenAddr   string

	// Assets is the list of underlyings to track. Venue slugs are fixed
	// (lighter, hyperliquid-xyz) and are wired to the corresponding
	// fetcher in main.go via a switch.
	Assets []AssetConfig

	// SizeBuckets is the set of USD notionals walked on both sides of
	// every book each tick. Emitted as the `size_usd` metric label.
	SizeBuckets []float64
}

// AssetConfig pairs one asset symbol with the per-venue identifiers each
// upstream expects. Lighter uses a numeric market_id, HL HIP-3 uses the
// deployer-namespaced coin symbol like "xyz:BOT".
type AssetConfig struct {
	Asset            string
	LighterMarketID  int
	HyperliquidCoin  string
}

func loadConfig() *Config {
	c := &Config{
		TickInterval: 30 * time.Second,
		ListenAddr:   ":2112",
		Assets: []AssetConfig{
			{
				Asset:           "BOT",
				LighterMarketID: 185,
				HyperliquidCoin: "xyz:BOT",
			},
		},
		SizeBuckets: []float64{100, 1000, 5000, 10000, 25000, 50000, 100000, 500000},
	}

	if v := os.Getenv("TICK_INTERVAL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.TickInterval = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("LISTEN_ADDR"); v != "" {
		c.ListenAddr = v
	}

	fmt.Printf("Config: assets=%d, sizes=%v, tick=%v, listen=%s\n",
		len(c.Assets), c.SizeBuckets, c.TickInterval, c.ListenAddr)
	for _, a := range c.Assets {
		fmt.Printf("  %s -> lighter market_id=%d, hyperliquid coin=%s\n",
			a.Asset, a.LighterMarketID, a.HyperliquidCoin)
	}
	return c
}
