package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Two histograms per Axelar GMP message so both fair-comparisons are
// available downstream:
//   - `axelar_gmp_confirm_latency_milliseconds` = source tx observed by Axelar
//     validators, quorum signed (`time_spent.call_confirm`). Direct
//     analogue of Wormhole VAA finalization time.
//   - `axelar_gmp_e2e_latency_milliseconds` = source tx submitted to destination
//     executed (`time_spent.total`). Analogue of LayerZero/CCIP/Hyperlane
//     end-to-end delivery.
//
// Buckets aligned with the other three e2e cross-chain messaging
// benches (CCIP, LayerZero, Hyperlane) up to 90 min so the meta-bench
// (cross-chain-messaging-latency) compares equivalent bucket
// resolution across all four protocols. Axelar validators wait for
// source-chain finality on Ethereum (~20 min), so ETH-source lanes
// legitimately reach 30-40 min end-to-end and must not be capped.
var (
	axelarConfirmLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "axelar_gmp_confirm_latency_milliseconds",
			Help:    "Axelar GMP source tx to validator quorum confirmation latency (ms), from time_spent.call_confirm.",
			Buckets: []float64{5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 2_400_000, 3_000_000, 3_600_000, 4_500_000, 5_400_000},
		},
		[]string{"source_chain"},
	)

	axelarE2ELatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "axelar_gmp_e2e_latency_milliseconds",
			Help:    "Axelar GMP end-to-end delivery latency (ms), from source tx to destination execution, via time_spent.total.",
			Buckets: []float64{5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 2_400_000, 3_000_000, 3_600_000, 4_500_000, 5_400_000},
		},
		[]string{"source_chain", "dest_chain"},
	)

	axelarSeenTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "axelar_gmp_seen_total",
			Help: "Total unique EXECUTED Axelar GMP messages observed, by source + destination chain.",
		},
		[]string{"source_chain", "dest_chain"},
	)

	axelarStatusTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "axelar_gmp_status_total",
			Help: "Axelar GMP messages seen per status (called, confirmed, approved, executed, error, ...), by source chain.",
		},
		[]string{"source_chain", "status"},
	)

	axelarPollErrors = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "axelar_gmp_poll_errors_total",
			Help: "Total failed pollings of the AxelarScan /gmp/searchGMP feed.",
		},
	)

	axelarDedupeCacheSize = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "axelar_gmp_dedupe_cache_size",
			Help: "Number of recent Axelar GMP message ids the monitor keeps for deduplication.",
		},
	)
)

func init() {
	prometheus.MustRegister(axelarConfirmLatencyMs)
	prometheus.MustRegister(axelarE2ELatencyMs)
	prometheus.MustRegister(axelarSeenTotal)
	prometheus.MustRegister(axelarStatusTotal)
	prometheus.MustRegister(axelarPollErrors)
	prometheus.MustRegister(axelarDedupeCacheSize)
}
