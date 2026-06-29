package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// userAgent identifies every request per the OCB methodology page.
const userAgent = "OpenChainBench/1.0 (+https://openchainbench.com/methodology; contact@mobula.io)"

// Fact-checked live 2026-06-12 against Polygon mainnet:
//   - 0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7 (UmaCtfAdapter, binary
//     markets, ~4.9k QuestionResolved/day)
//   - 0x69c47De9D4D3Dad79590d61b9e05918E03775f24 (UmaCtfAdapter, neg-risk
//     variant, ~0.7k QuestionResolved/day)
//
// These are the post-migration deployments (Gamma `resolvedBy` points at
// them); the historical V1/V2/V3 adapters (0xCB18..., 0x2F5e..., 0x6A9D...)
// are silent. New deployments are config, not code: override via
// ADAPTER_ADDRESSES.
const defaultAdapters = "0x65070be91477460d8a7aeeb94ef92fe056c2f2a7,0x69c47de9d4d3dad79590d61b9e05918e03775f24"

// UMA Optimistic Oracle the adapters above request prices from. Located by
// tracing a live initialize() tx; emits OOV2-shaped RequestPrice /
// ProposePrice / DisputePrice / Settle events. Override via OO_ADDRESSES.
const defaultOO = "0x2c0367a9db231ddebd88a94b4f6461a6e47c58b1"

// Free public Polygon RPCs verified to serve eth_getLogs (tenderly is the
// most reliable; publicnode times out on large ranges but works as backup).
const defaultRPCs = "https://gateway.tenderly.co/public/polygon,https://polygon-bor-rpc.publicnode.com"

const gammaBase = "https://gamma-api.polymarket.com"

func envDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func envList(key, fallback string) []string {
	raw := envDefault(key, fallback)
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.ToLower(strings.TrimSpace(p))
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

var (
	adapterAddresses = envList("ADAPTER_ADDRESSES", defaultAdapters)
	ooAddresses      = envList("OO_ADDRESSES", defaultOO)
	rpcURLs          = envList("RPC_URLS", defaultRPCs)

	// backfillHours: how far back to rebuild state on startup. 7 days keeps
	// restarts cheap on free RPCs while re-covering any gap.
	backfillHours = envInt("BACKFILL_HOURS", 168)
	// chunkBlocks: eth_getLogs range per request. Free tiers cap at 2-10k.
	chunkBlocks = envInt("CHUNK_BLOCKS", 2000)
	// pollSeconds: incremental log poll cadence.
	pollSeconds = envInt("POLL_SECONDS", 45)

	pollInterval = time.Duration(pollSeconds) * time.Second
)
