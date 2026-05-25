package main

import (
	"os"
	"strings"
)

// L2Chain is one Layer-2 chain we measure. Each declares a public
// WebSocket endpoint that supports `eth_subscribe("newHeads")` without
// an API key. Block-time metrics are recorded from the wall-clock
// interval between successive newHeads events.
type L2Chain struct {
	Slug string
	Name string
	URL  string
}

// l2Chains is the source of truth for which Layer-2s appear in the
// bench. The default endpoints are all public, no-key, verified live
// at miniapp inception (see README for the probe results). Each URL
// can be overridden via env var (e.g. RPC_WS_ARBITRUM) without a
// rebuild — useful if a public endpoint goes flaky.
func l2Chains() []L2Chain {
	return []L2Chain{
		{
			Slug: "arbitrum",
			Name: "Arbitrum One",
			URL:  envDefault("RPC_WS_ARBITRUM", "wss://arbitrum-one-rpc.publicnode.com"),
		},
		{
			Slug: "optimism",
			Name: "Optimism",
			URL:  envDefault("RPC_WS_OPTIMISM", "wss://optimism-rpc.publicnode.com"),
		},
		{
			Slug: "base",
			Name: "Base",
			URL:  envDefault("RPC_WS_BASE", "wss://base-rpc.publicnode.com"),
		},
		{
			Slug: "zksync",
			Name: "zkSync Era",
			URL:  envDefault("RPC_WS_ZKSYNC", "wss://mainnet.era.zksync.io/ws"),
		},
		{
			Slug: "linea",
			Name: "Linea",
			URL:  envDefault("RPC_WS_LINEA", "wss://linea-rpc.publicnode.com"),
		},
		{
			Slug: "scroll",
			Name: "Scroll",
			URL:  envDefault("RPC_WS_SCROLL", "wss://scroll-rpc.publicnode.com"),
		},
		{
			Slug: "blast",
			Name: "Blast",
			URL:  envDefault("RPC_WS_BLAST", "wss://blast-rpc.publicnode.com"),
		},
		{
			Slug: "mantle",
			Name: "Mantle",
			URL:  envDefault("RPC_WS_MANTLE", "wss://mantle-rpc.publicnode.com"),
		},
		{
			Slug: "taiko",
			Name: "Taiko",
			URL:  envDefault("RPC_WS_TAIKO", "wss://taiko-rpc.publicnode.com"),
		},
	}
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// listenAddr is fixed to :2112 — same convention as every other OCB
// harness. Internal-only Railway service, scraped by the shared
// Prometheus at <service>.railway.internal:2112. We deliberately ignore
// $PORT so a Railway-injected public port doesn't move the listener
// away from the address Prometheus expects.
func listenAddr() string {
	return ":2112"
}
