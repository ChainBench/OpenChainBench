package main

import (
	"fmt"
	"net/http"
	"time"
)

// GMXNativeSource is a placeholder for the GMX V2 Synthetics volume source.
//
// Data source history and current status:
//   - stats.gmx.io: dead as of 2026-08, DNS no longer resolves. This was the
//     GMX stats backend that exposed rolling 24h volume per chain.
//   - arbitrum-api.gmxinfra.io: price oracle only; /volumes and /stats 404.
//   - The Graph / Goldsky: GMX V2 synthetics subgraph needs a paid API key.
//   - api.gmx.io/daily_volume: GMX V1 GLP swap volume only, not V2 perps.
//   - DefiLlama: derivatives volume behind the paid plan (402).
//
// Returns empty every tick; carry-forward holds the last successful value.
// Wire in THE_GRAPH_API_KEY or a restored stats endpoint to re-enable.
type GMXNativeSource struct {
	client *http.Client
}

func NewGMXNativeSource() *GMXNativeSource {
	return &GMXNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *GMXNativeSource) Name() string { return srcGMXNative }

func (s *GMXNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	fmt.Printf("[perp-cohort][gmx-v2][%s] no endpoint available (stats.gmx.io dead)\n", srcGMXNative)
	return res, nil
}
