package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// ccip_message_latency_milliseconds is a histogram of Chainlink CCIP
// end-to-end message latency, bucketed by source chain.
// Latency = `receiptTimestamp - sendTimestamp` from the CCIP Tools API
// `/v2/messages` payload, i.e. source-tx submission → destination
// execution. Emitted in MILLISECONDS to match the site's `unit: ms`
// display convention.
//
// Buckets extend beyond the Wormhole ceiling (30 min) to 90 min
// because CCIP structurally waits for source-chain finality before
// its DON commits: Ethereum-source lanes routinely take 13-15 min
// just for finality and ~21 min end-to-end. Without the extended
// tail, ETH p90/p99 would pin to the 30-min bucket edge (same
// failure mode we hit with Wormhole VAA on 2026-07-24).
//
// A companion label `dest_chain` is emitted so a matrix cell can
// slice by corridor, matching how the meta-bench aggregates it later.
var (
	ccipLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "ccip_message_latency_milliseconds",
			Help:    "End-to-end delivery latency (ms) for a Chainlink CCIP message, from source tx to destination execution, labeled by source + destination chain.",
			Buckets: []float64{5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 2_400_000, 3_000_000, 3_600_000, 4_500_000, 5_400_000},
		},
		[]string{"source_chain", "dest_chain"},
	)

	ccipSeenTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ccip_message_seen_total",
			Help: "Total unique successful CCIP messages observed by this monitor, by source + destination chain.",
		},
		[]string{"source_chain", "dest_chain"},
	)

	// Non-success statuses observed. CCIP messages flow through
	// SENT -> SOURCE_FINALIZED -> COMMITTED -> SUCCESS; we only
	// histogram SUCCESS but count the others so a spike in COMMITTED
	// without SUCCESS surfaces stuck delivery pipelines.
	ccipStatusTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ccip_message_status_total",
			Help: "CCIP messages seen per status (SENT, SOURCE_FINALIZED, COMMITTED, SUCCESS, FAILED, ...), by source chain.",
		},
		[]string{"source_chain", "status"},
	)

	ccipPollErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "ccip_message_poll_errors_total",
			Help: "Total failed pollings of the CCIP Tools /v2/messages feed.",
		},
	)

	ccipDedupeCacheSize = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "ccip_message_dedupe_cache_size",
			Help: "Number of recent CCIP message ids the monitor keeps for deduplication.",
		},
	)
)

func init() {
	prometheus.MustRegister(ccipLatencyMs)
	prometheus.MustRegister(ccipSeenTotal)
	prometheus.MustRegister(ccipStatusTotal)
	prometheus.MustRegister(ccipPollErrors)
	prometheus.MustRegister(ccipDedupeCacheSize)
}
