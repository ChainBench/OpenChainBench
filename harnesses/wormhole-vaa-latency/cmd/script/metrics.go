package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// wormhole_vaa_latency_seconds is a histogram of finalization latency,
// bucketed by source chain (Wormhole emitterChain). Latency is defined
// as `updatedAt − timestamp` from the wormholescan `/api/v1/vaas`
// payload: source-chain observation → Guardian quorum + indexer.
//
// Buckets are geometric across the observed distribution (BSC ~5-11s,
// Ethereum ~15-25s, Solana ~17-26s, Moonbeam ~40s, worst case >5min on
// slow chains during backfills).
var (
	vaaLatencySeconds = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "wormhole_vaa_latency_seconds",
			Help:    "Time from source-chain observation to Guardian quorum for a Wormhole VAA, by source chain.",
			Buckets: []float64{2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600},
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
	prometheus.MustRegister(vaaLatencySeconds)
	prometheus.MustRegister(vaaSeenTotal)
	prometheus.MustRegister(pollErrors)
	prometheus.MustRegister(dedupeCacheSize)
}
