package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// hyperlane_message_latency_milliseconds is a histogram of Hyperlane
// end-to-end message delivery latency, bucketed by source + destination
// chain.
// Latency = `delivery_occurred_at - send_occurred_at` from the
// Hyperlane Explorer GraphQL feed. This is protocol-observed
// delivery latency (whichever relayer actually delivered the
// message), so it reflects the practical UX rather than a
// theoretical protocol floor.
//
// Emitted in MILLISECONDS to match the site's `unit: ms` display
// convention. Buckets 2s-30min.
var (
	hyperlaneLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "hyperlane_message_latency_milliseconds",
			Help:    "End-to-end delivery latency (ms) for a Hyperlane message, from source send to destination delivery, labeled by source + destination chain.",
			Buckets: []float64{2_000, 5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000},
		},
		[]string{"source_chain", "dest_chain"},
	)

	hyperlaneSeenTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "hyperlane_message_seen_total",
			Help: "Total unique DELIVERED Hyperlane messages observed, by source + destination chain.",
		},
		[]string{"source_chain", "dest_chain"},
	)

	// Undelivered messages counted separately (permissionless relayers
	// mean some routes go under-served; a spike here surfaces stuck
	// relayer coverage rather than protocol latency).
	hyperlaneUndeliveredTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "hyperlane_message_undelivered_total",
			Help: "Hyperlane messages observed with is_delivered=false, by source chain.",
		},
		[]string{"source_chain"},
	)

	hyperlanePollErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "hyperlane_message_poll_errors_total",
			Help: "Total failed pollings of the Hyperlane Explorer GraphQL feed.",
		},
	)

	hyperlaneDedupeCacheSize = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "hyperlane_message_dedupe_cache_size",
			Help: "Number of recent Hyperlane message ids the monitor keeps for deduplication.",
		},
	)
)

func init() {
	prometheus.MustRegister(hyperlaneLatencyMs)
	prometheus.MustRegister(hyperlaneSeenTotal)
	prometheus.MustRegister(hyperlaneUndeliveredTotal)
	prometheus.MustRegister(hyperlanePollErrors)
	prometheus.MustRegister(hyperlaneDedupeCacheSize)
}
