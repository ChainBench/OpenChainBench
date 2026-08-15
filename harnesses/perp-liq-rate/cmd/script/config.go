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
)

// loadConfig reads environment variables and builds the venue registry.
//
// Environment:
//
//	TICK_INTERVAL_SECONDS — poll interval, default 300
//	RPC_BASE              — Base mainnet JSON-RPC URL, default https://mainnet.base.org
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
	gains := NewGains(rpcBase)
	dydx := NewDydx()
	gmx := NewGMX()
	lighter := NewLighter()
	aevo := NewAevo()
	paradex := NewParadex()

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
	}

	return &Config{
		TickInterval: time.Duration(tickSeconds) * time.Second,
		ListenAddr:   listen,
		RPCBase:      rpcBase,
		Pairs:        pairs,
	}, nil
}
