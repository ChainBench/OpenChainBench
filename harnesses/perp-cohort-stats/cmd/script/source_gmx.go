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
//     GMX stats backend that exposed rolling 24h volume per chain (Arbitrum,
//     Avalanche). The backend was a separate service from the price oracle.
//   - arbitrum-api.gmxinfra.io: price oracle only. /volumes and /stats
//     return 404; no volume endpoint is exposed.
//   - The Graph / Goldsky: GMX V2 synthetics subgraph needs a paid API key.
//   - api.gmx.io/daily_volume: GMX V1 GLP swap volume (BuyUSDG/SellUSDG),
//     NOT perp position volume — not usable as a V2 proxy.
//   - DefiLlama: derivatives/volume behind the paid plan (402).
//
// Until a free GMX V2 perp volume endpoint is found, this source returns
// empty every tick. The carry-forward mechanism in the router will hold the
// last successful value (initially nothing, which leaves gmx-v2 at zero).
// The health gauge reflects this as a partial miss on mVolume24h.
//
// To restore: wire in the GMX V2 subgraph via THE_GRAPH_API_KEY env var, or
// use stats.gmx.io once their stats backend is re-deployed.
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
	fmt.Printf("[perp-cohort][gmx-v2][%s] no endpoint available (stats.gmx.io dead; see source comment)\n", srcGMXNative)
	return res, nil
}
