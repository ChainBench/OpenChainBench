package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Venues       []VenueConfig
	Interval     time.Duration
	NotionalUSD  float64
	MobulaAPIKey string // for /api/2/perp/quote
}

// venueDef pairs a venue with the assets it supports natively.
type venueDef struct {
	slug    string
	display string
	assets  []string
}

func loadConfig() *Config {
	notional := 1000.0
	if v := os.Getenv("PERP_NOTIONAL_USD"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
			notional = n
		}
	}

	defs := []venueDef{
		{slug: "hyperliquid", display: "Hyperliquid", assets: []string{"ETH", "BTC", "SOL"}},
		{slug: "dydx", display: "dYdX v4", assets: []string{"ETH", "BTC", "SOL"}},
		{slug: "lighter", display: "Lighter", assets: []string{"ETH", "BTC", "SOL"}},
		// GMX v2 has separate market addresses per asset; the gmx fetcher
		// maps asset → market address (gmxMarkets in gmx.go), verified
		// against gmxinfra /markets/info.
		{slug: "gmx", display: "GMX v2", assets: []string{"ETH", "BTC", "SOL"}},
		// Gains v8 on Base — reads fees on-chain via Base RPC. Pair index
		// for each asset is discovered by scanning the diamond's
		// `pairs(N)` slot for the asset/USD name match (findGainsPair in
		// gains.go).
		{slug: "gains", display: "Gains Network", assets: []string{"ETH", "BTC", "SOL"}},
		// Polymarket perps (2026-07-08 launch): public info API, base fee
		// tier taker 4 bps. ETH/BTC/SOL all listed at launch.
		{slug: "polymarket", display: "Polymarket", assets: []string{"ETH", "BTC", "SOL"}},
		{slug: "paradex", display: "Paradex", assets: []string{"ETH", "BTC", "SOL"}},
		// Extended's taker fee is documented (2.5 bps), not API-exposed;
		// disclosed in the spec formula.
		{slug: "extended", display: "Extended", assets: []string{"ETH", "BTC", "SOL"}},
	}

	venues := make([]VenueConfig, 0, len(defs)*3)
	for _, d := range defs {
		for _, a := range d.assets {
			venues = append(venues, VenueConfig{
				Slug:        d.slug,
				Display:     d.display,
				Asset:       a,
				NotionalUSD: notional,
			})
		}
	}

	c := &Config{
		Interval:     5 * time.Minute,
		NotionalUSD:  notional,
		MobulaAPIKey: os.Getenv("MOBULA_API_KEY"),
		Venues:       venues,
	}

	if v := os.Getenv("REFRESH_INTERVAL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 30 {
			c.Interval = time.Duration(n) * time.Second
		}
	}

	fmt.Printf("Config: %d venue×asset pairs, refresh=%v, notional=$%.0f\n", len(c.Venues), c.Interval, c.NotionalUSD)
	for _, v := range c.Venues {
		fmt.Printf("  %-12s %s\n", v.Slug+"/"+v.Asset, v.Display)
	}
	return c
}
