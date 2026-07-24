package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// wormhole_vaa_latency_milliseconds is a histogram of Wormhole VAA
// finalization latency, bucketed by source chain (Wormhole emitterChain).
// Latency = `indexedAt − timestamp` from the wormholescan /api/v1/vaas
// payload: source-chain block observation → Guardian quorum reached +
// wormholescan first-index. Emitted in MILLISECONDS to match the site's
// display convention (unit: ms auto-formatting to "1.2 s" for values >
// 1000ms, "234 ms" otherwise). Emitting seconds instead broke the
// display formatter (2026-07-24 diagnosis: 4.25s displayed as "0.0 s"
// after the site's built-in /1000 normalization).
//
// Buckets span the full observed range: fast chains (BSC ~5-11s,
// Solana ~17-26s, Moonbeam ~40s) up through Ethereum/Arbitrum whose
// VAAs only sign after L1 Casper FFG finality (~12.8 min ideal, up
// to ~19 min real). Ceiling at 30 min catches the true tail without
// pinning p90/p99 to a bucket edge (2026-07-24: prior 600_000ms cap
// reported Ethereum/Arbitrum p50 as 600s = bucket edge, not real).
var (
	vaaLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "wormhole_vaa_latency_milliseconds",
			Help:    "Time in milliseconds from source-chain observation to Guardian quorum for a Wormhole VAA, by source chain.",
			Buckets: []float64{2_000, 5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000},
		},
		[]string{"source_chain"},
	)

	vaaSeenTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "wormhole_vaa_seen_total",
			Help: "Total number of unique VAAs observed by this monitor, by source chain.",
		},
		[]string{"source_chain"},
	)

	pollErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "wormhole_vaa_poll_errors_total",
			Help: "Total number of failed pollings of the wormholescan VAA feed.",
		},
	)

	dedupeCacheSize = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "wormhole_vaa_dedupe_cache_size",
			Help: "Number of recent VAA ids the monitor keeps for deduplication.",
		},
	)
)

func init() {
	prometheus.MustRegister(vaaLatencyMs)
	prometheus.MustRegister(vaaSeenTotal)
	prometheus.MustRegister(pollErrors)
	prometheus.MustRegister(dedupeCacheSize)
}
