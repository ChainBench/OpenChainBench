package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// lz_message_latency_milliseconds is a histogram of LayerZero end-to-end
// message delivery latency, bucketed by source + destination chain.
// Latency = `destination.tx.blockTimestamp - source.tx.blockTimestamp`
// from the layerzero-scan `/v1/messages/latest` payload. Timestamps are
// source-chain and destination-chain block times, so this measures
// wall-clock delivery time as experienced end-to-end (DVN verification
// + executor delivery), not just protocol signing latency.
//
// Emitted in MILLISECONDS to match the site's `unit: ms` display
// convention. Buckets aligned with the other three e2e cross-chain
// messaging benches (CCIP, Hyperlane, Axelar) — up to 90 min — so
// the cross-chain-messaging-latency meta-bench compares equivalent
// bucket resolution across all four protocols. LayerZero typically
// runs a few minutes end-to-end but real stuck deliveries at 30-60
// min have been observed on low-liquidity DVN configurations, and
// the tail must be preserved for honest p99.
var (
	lzLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "lz_message_latency_milliseconds",
			Help:    "End-to-end delivery latency (ms) for a LayerZero message, from source-chain block to destination-chain block, labeled by source + destination chain.",
			Buckets: []float64{5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 2_400_000, 3_000_000, 3_600_000, 4_500_000, 5_400_000},
		},
		[]string{"source_chain", "dest_chain"},
	)

	lzSeenTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lz_message_seen_total",
			Help: "Total unique DELIVERED LayerZero messages observed by this monitor, by source + destination chain.",
		},
		[]string{"source_chain", "dest_chain"},
	)

	// Non-DELIVERED statuses observed once per guid: INFLIGHT, CONFIRMING,
	// FAILED, PAYLOAD_STORED, BLOCKED, etc. Surface stuck-message spikes
	// without polluting the latency histogram.
	lzStatusTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "lz_message_status_total",
			Help: "LayerZero messages seen per status (DELIVERED, INFLIGHT, CONFIRMING, FAILED, ...), by source chain.",
		},
		[]string{"source_chain", "status"},
	)

	lzPollErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "lz_message_poll_errors_total",
			Help: "Total failed pollings of the LayerZero-scan /v1/messages/latest feed.",
		},
	)

	lzDedupeCacheSize = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "lz_message_dedupe_cache_size",
			Help: "Number of recent LayerZero guids the monitor keeps for deduplication.",
		},
	)
)

func init() {
	prometheus.MustRegister(lzLatencyMs)
	prometheus.MustRegister(lzSeenTotal)
	prometheus.MustRegister(lzStatusTotal)
	prometheus.MustRegister(lzPollErrors)
	prometheus.MustRegister(lzDedupeCacheSize)
}
