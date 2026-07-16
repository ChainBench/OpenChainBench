package main

import (
	"os"
	"strings"
)

// Endpoint is one (provider, chain) WebSocket subscription. Each entry
// gets its own goroutine holding a persistent connection; the arrival
// timestamps from every endpoint on the same chain are pooled by the
// per-chain cohort (see cohort.go logic in evm_ws.go / solana_ws.go and
// the shared aggregator below).
type Endpoint struct {
	Provider string
	Chain    string // ethereum | base | solana
	Kind     string // "evm" (eth_subscribe newHeads) | "solana" (slotSubscribe)
	URL      string
}

// endpoints is the source of truth for the measured cohort. All default
// URLs are public and keyless, verified live at harness inception:
//
//	publicnode: ethereum / base / solana all push events
//	drpc:       ethereum verified; base + solana declared and allowed to
//	            fail at runtime (per-connection reconnect loop degrades
//	            gracefully, never crashes the process)
//	tenderly:   ethereum only (no keyless base/solana WS)
//
// Optional keyed providers are appended from env vars so contributor
// keys can widen the cohort without a rebuild. Every default URL is
// also env-overridable via WS_URL_<PROVIDER>_<CHAIN>.
func endpoints() []Endpoint {
	eps := []Endpoint{
		{Provider: "publicnode", Chain: "ethereum", Kind: "evm", URL: envDefault("WS_URL_PUBLICNODE_ETHEREUM", "wss://ethereum-rpc.publicnode.com")},
		{Provider: "publicnode", Chain: "base", Kind: "evm", URL: envDefault("WS_URL_PUBLICNODE_BASE", "wss://base-rpc.publicnode.com")},
		{Provider: "publicnode", Chain: "solana", Kind: "solana", URL: envDefault("WS_URL_PUBLICNODE_SOLANA", "wss://solana-rpc.publicnode.com")},
		{Provider: "drpc", Chain: "ethereum", Kind: "evm", URL: envDefault("WS_URL_DRPC_ETHEREUM", "wss://eth.drpc.org")},
		{Provider: "drpc", Chain: "base", Kind: "evm", URL: envDefault("WS_URL_DRPC_BASE", "wss://base.drpc.org")},
		{Provider: "drpc", Chain: "solana", Kind: "solana", URL: envDefault("WS_URL_DRPC_SOLANA", "wss://solana.drpc.org")},
		{Provider: "tenderly", Chain: "ethereum", Kind: "evm", URL: envDefault("WS_URL_TENDERLY_ETHEREUM", "wss://mainnet.gateway.tenderly.co")},
		{Provider: "solana-labs", Chain: "solana", Kind: "solana", URL: envDefault("WS_URL_SOLANALABS_SOLANA", "wss://api.mainnet-beta.solana.com")},
	}
	// Keyed providers, skipped when the env var is unset. URLs carry the
	// key inline (e.g. wss://eth-mainnet.g.alchemy.com/v2/<key>) so they
	// live in the deployment env, never in the repo. The public keyless
	// cohort is already saturated on every chain (Ankr, Blast, LlamaRPC,
	// BlockPI, 1RPC, NodeReal, Omniatech all failed a live WSS handshake
	// as of 2026-07 audit), so any new cohort member comes in via one of
	// the slots below.
	for _, opt := range []struct{ env, provider, chain, kind string }{
		// Ethereum keyed
		{"WS_URL_ALCHEMY_ETHEREUM", "alchemy", "ethereum", "evm"},
		{"WS_URL_INFURA_ETHEREUM", "infura", "ethereum", "evm"},
		{"WS_URL_CHAINSTACK_ETHEREUM", "chainstack", "ethereum", "evm"},
		{"WS_URL_QUICKNODE_ETHEREUM", "quicknode", "ethereum", "evm"},
		// Base keyed
		{"WS_URL_ALCHEMY_BASE", "alchemy", "base", "evm"},
		{"WS_URL_INFURA_BASE", "infura", "base", "evm"},
		{"WS_URL_CHAINSTACK_BASE", "chainstack", "base", "evm"},
		{"WS_URL_QUICKNODE_BASE", "quicknode", "base", "evm"},
		// Solana keyed
		{"WS_URL_ALCHEMY_SOLANA", "alchemy", "solana", "solana"},
		{"WS_URL_CHAINSTACK_SOLANA", "chainstack", "solana", "solana"},
		{"WS_URL_HELIUS_SOLANA", "helius", "solana", "solana"},
		{"WS_URL_QUICKNODE_SOLANA", "quicknode", "solana", "solana"},
	} {
		if url := strings.TrimSpace(os.Getenv(opt.env)); url != "" {
			eps = append(eps, Endpoint{Provider: opt.provider, Chain: opt.chain, Kind: opt.kind, URL: url})
		}
	}
	return eps
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// listenAddr defaults to :2112, the OCB harness convention (scraped by
// the shared Prometheus). LISTEN_ADDR overrides for local runs so a dev
// copy doesn't collide with a deployed harness.
func listenAddr() string {
	return envDefault("LISTEN_ADDR", ":2112")
}
