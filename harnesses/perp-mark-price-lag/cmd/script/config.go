package main

import (
	"fmt"
	"os"
	"time"
)

// Config holds the harness runtime configuration.
type Config struct {
	Venues   []VenueConfig
	Interval time.Duration
}

func loadConfig() *Config {
	interval := 60 * time.Second
	if v := os.Getenv("REFRESH_INTERVAL_SECONDS"); v != "" {
		var s int
		if _, err := fmt.Sscanf(v, "%d", &s); err == nil && s > 0 {
			interval = time.Duration(s) * time.Second
		}
	}

	assets := []string{"ETH", "BTC", "SOL"}
	slugs := []string{"gains", "gmx", "hyperliquid", "dydx", "lighter", "paradex"}

	venues := make([]VenueConfig, 0, len(slugs)*len(assets))
	for _, slug := range slugs {
		for _, asset := range assets {
			venues = append(venues, VenueConfig{Slug: slug, Asset: asset})
		}
	}

	return &Config{
		Venues:   venues,
		Interval: interval,
	}
}
