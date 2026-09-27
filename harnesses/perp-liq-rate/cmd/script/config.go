package main

// config.go — environment handling and the VenueAsset registry that binds
// every (venue, asset) pair to its Source implementation.

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// VenueAsset binds one venue+asset pair to the Source that serves it.
// Several pairs may share a single Source instance (per-venue state such as
// the gains block cursor lives on that instance).
type VenueAsset struct {
	Venue  string
	Asset  string
	Source Source
}

// Config is the fully resolved runtime configuration.
type Config struct {
	TickInterval time.Duration
	ListenAddr   string
	RPCBase      string
	Pairs        []VenueAsset
}

const (
	defaultTickSeconds = 300
	defaultListenAddr  = ":2112"
	defaultRPCBase     = "https://mainnet.base.org"
	defaultRPCArbitrum = "https://arb1.arbitrum.io/rpc"
)

// loadConfig reads environment variables and builds the venue registry.
//
// Environment:
//
//	TICK_INTERVAL_SECONDS — poll interval, default 300
//	RPC_BASE              — Base mainnet JSON-RPC URL, default https://mainnet.base.org
//	RPC_ARBITRUM          — Arbitrum One JSON-RPC URL (Gains' main deployment), default https://arb1.arbitrum.io/rpc
//	LISTEN_ADDR           — metrics listen address, default :2112
func loadConfig() (*Config, error) {
	tickSeconds := defaultTickSeconds
	if v := os.Getenv("TICK_INTERVAL_SECONDS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("invalid TICK_INTERVAL_SECONDS %q", v)
		}
		tickSeconds = n
	}

	rpcBase := os.Getenv("RPC_BASE")
	if rpcBase == "" {
		rpcBase = defaultRPCBase
	}

	listen := os.Getenv("LISTEN_ADDR")
	if listen == "" {
		listen = defaultListenAddr
	}

	hyperliquid := NewHyperliquid()
	// Gains: Base plus Arbitrum (where the venue's open interest lives).
	rpcArbitrum := os.Getenv("RPC_ARBITRUM")
	if rpcArbitrum == "" {
		rpcArbitrum = defaultRPCArbitrum
	}
	gains := NewGainsMulti(NewGains(rpcBase), NewGainsArbitrum(rpcArbitrum))
	dydx := NewDydx()
	gmx := NewGMX()
	lighter := NewLighter()
	aevo := NewAevo()
	paradex := NewParadex()
	// Added 2026-09-27: two venues whose liquidation feed was checked and
	// found to exist. Aster via Coinalyze (exchange code S), Ostium via the
	// Ormi subgraph the cohort harness reads. Slugs and display names match
	// the site's perp venue registry so the product pages keep joining.
	aster := NewAster()
	ostium := NewOstium()
	// Orderly has the only purpose-built public liquidation endpoint in the
	// cohort with real history. Nado publishes a cumulative liquidated-USD
	// counter instead of a tape, so its 24h figure is one aggregate number.
	orderly := NewOrderly()
	nado := NewNado()

	pairs := []VenueAsset{
		{Venue: "hyperliquid", Asset: "ETH", Source: hyperliquid},
		{Venue: "hyperliquid", Asset: "BTC", Source: hyperliquid},
		{Venue: "hyperliquid", Asset: "SOL", Source: hyperliquid},

		{Venue: "gains", Asset: "ETH", Source: gains},
		{Venue: "gains", Asset: "BTC", Source: gains},

		{Venue: "dydx", Asset: "ETH", Source: dydx},
		{Venue: "dydx", Asset: "BTC", Source: dydx},
		{Venue: "dydx", Asset: "SOL", Source: dydx},

		{Venue: "gmx", Asset: "ETH", Source: gmx},
		{Venue: "gmx", Asset: "BTC", Source: gmx},

		{Venue: "lighter", Asset: "ETH", Source: lighter},
		{Venue: "lighter", Asset: "BTC", Source: lighter},

		{Venue: "aevo", Asset: "ETH", Source: aevo},
		{Venue: "aevo", Asset: "BTC", Source: aevo},

		{Venue: "paradex", Asset: "ETH", Source: paradex},
		{Venue: "paradex", Asset: "BTC", Source: paradex},

		{Venue: "aster", Asset: "ETH", Source: aster},
		{Venue: "aster", Asset: "BTC", Source: aster},
		{Venue: "aster", Asset: "SOL", Source: aster},

		{Venue: "ostium", Asset: "ETH", Source: ostium},
		{Venue: "ostium", Asset: "BTC", Source: ostium},

		{Venue: "orderly", Asset: "ETH", Source: orderly},
		{Venue: "orderly", Asset: "BTC", Source: orderly},
		{Venue: "orderly", Asset: "SOL", Source: orderly},

		{Venue: "nado", Asset: "ETH", Source: nado},
		{Venue: "nado", Asset: "BTC", Source: nado},
	}

	return &Config{
		TickInterval: time.Duration(tickSeconds) * time.Second,
		ListenAddr:   listen,
		RPCBase:      rpcBase,
		Pairs:        pairs,
	}, nil
}
