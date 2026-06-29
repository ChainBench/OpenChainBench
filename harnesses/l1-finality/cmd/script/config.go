package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type ChainKind string

const (
	KindEVM     ChainKind = "evm"
	KindSolana  ChainKind = "solana"
	KindTron    ChainKind = "tron"
	KindXRP     ChainKind = "xrp"
	KindStellar ChainKind = "stellar"
	KindHedera  ChainKind = "hedera"
	KindSui     ChainKind = "sui"
	KindTon     ChainKind = "gram"
	// PoW chains — "finalized" approximated by N confirmations.
	KindBitcoinLike ChainKind = "bitcoin_like"
	KindMonero      ChainKind = "monero"
	KindCardano     ChainKind = "cardano"
)

// ChainConfig describes one L1 we want to measure.
type ChainConfig struct {
	Slug   string    // stable, used as Prom label (e.g. "ethereum")
	Name   string    // display label ("Ethereum")
	Kind   ChainKind // protocol family — picks the fetcher
	RPCURL string    // public JSON-RPC / API endpoint
	// Confirmations to consider a block "finalized" — used by PoW kinds
	// where finality is probabilistic. Ignored otherwise.
	Confirmations int
	// Optional per-chain minimum poll interval. Used when an upstream API
	// has a daily request quota (Koios free tier on Cardano is 5k/day —
	// our default 10s cadence burns through it in 14h, then the IP gets
	// blocked). 0 = use the global Interval.
	MinIntervalSeconds int
}

type Config struct {
	Chains   []ChainConfig
	Interval time.Duration
}

func loadConfig() *Config {
	c := &Config{
		Interval: 10 * time.Second,
		Chains: []ChainConfig{
			{
				Slug:   "ethereum",
				Name:   "Ethereum",
				Kind:   KindEVM,
				RPCURL: getenvDefault("RPC_ETHEREUM", "https://ethereum.publicnode.com"),
			},
			// BNB and Avalanche removed: their finality (~1-2s) is faster
			// than our 10s poll cadence. Comparing latest.timestamp with
			// finalized.timestamp at one poll instant doesn't measure
			// "time to finalize a block" — it measures the current gap,
			// which collapses to 0 when finalization catches up to head.
			// The methodology only works when finality > poll interval.
			// Re-enable with WS wall-clock measurement (observe block N
			// as latest at T1, as finalized at T2, lag = T2 - T1).
			{
				Slug:   "solana",
				Name:   "Solana",
				Kind:   KindSolana,
				RPCURL: getenvDefault("RPC_SOLANA", "https://api.mainnet-beta.solana.com"),
			},
			{
				Slug:   "tron",
				Name:   "TRON",
				Kind:   KindTron,
				RPCURL: getenvDefault("RPC_TRON", "https://api.trongrid.io"),
			},
			// XRP removed: ledger_current has no close_time, so the lag
			// formula was hardcoded as block_lag × 4 s. Not a real
			// measurement. Re-enable when we measure via WS subscribe.
			// Stellar moved to SSE wall-clock — see stellar_ws.go (Horizon
			// /ledgers?cursor=now stream). HTTP timestamp diff was just the
			// inter-ledger interval, not user-perceived finality.
			//
			// Hedera removed entirely. The mirror node only exposes
			// already-finalized blocks (Hashgraph aBFT), so wall-clock
			// measurement of consensus lag is impossible from public
			// endpoints. Block Nodes (HIP-1056) are still in private
			// preview as of May 2026.
			//
			// SUI moved to high-frequency HTTP polling wall-clock — see
			// sui_ws.go. Same methodology mismatch as before fixed.
			// TON removed from HTTP polling — same issue as BNB/Avalanche
			// (masterchain blocks finalize in ~0.5s, polling 10s = wrong
			// methodology). Now measured via SSE wall-clock subscriber on
			// tonapi.io's /v2/sse/blocks stream.
			{
				Slug: "litecoin",
				Name: "Litecoin",
				Kind: KindBitcoinLike,
				// Switched from blockchair (free-tier IP blacklist hit on
				// 2026-05-31, 100% 430 responses) to litecoinspace.org's
				// Esplora-compatible API. Fewer calls per tick (1 vs 2) and
				// no auth required.
				RPCURL: getenvDefault("RPC_LITECOIN", "https://litecoinspace.org/api"),
				// Coinbase deposit standard for LTC. The April 2026 13-block
				// MWEB reorg made 6 unsafe; 12 is the post-incident floor.
				Confirmations: 12,
			},
			{
				Slug:          "monero",
				Name:          "Monero",
				Kind:          KindMonero,
				RPCURL:        getenvDefault("RPC_MONERO", "https://xmr-node.cakewallet.com:18081"),
				Confirmations: 10,
			},
			{
				Slug: "cardano",
				Name: "Cardano",
				Kind: KindCardano,
				RPCURL: getenvDefault("RPC_CARDANO", "https://api.koios.rest/api/v1"),
				// Practical settlement standard. Coinbase = 10, Kraken = 15.
				// Picking 15 — protects above k_practical, well below the
				// theoretical k = 2160 (~12h) which no production actor uses.
				Confirmations: 15,
				// Koios free tier: 5,000 req/day per IP. Our 2-call cadence at
				// the global 10s interval = 17,280 req/day — burns the quota in
				// ~7h then the IP gets blocked. 60s cadence = 2,880 req/day,
				// safely under quota. Cardano blocks are ~20s, so per-minute
				// resolution is fine for a finality-lag metric that updates
				// over multi-minute windows anyway (15 confs × 20s = 5 min).
				MinIntervalSeconds: 60,
			},
		},
	}

	if v := os.Getenv("REFRESH_INTERVAL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 5 {
			c.Interval = time.Duration(n) * time.Second
		}
	}

	fmt.Printf("Config: %d chains, refresh=%v\n", len(c.Chains), c.Interval)
	for _, ch := range c.Chains {
		fmt.Printf("  %-10s %s\n", ch.Slug, ch.RPCURL)
	}
	return c
}

func getenvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
