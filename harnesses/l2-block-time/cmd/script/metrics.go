package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics emitted by the l2-block-time harness. Names follow the
// `<bench>_<measurement>_<unit>` convention used by every other OCB
// bench. Querying patterns (p50/p90/p99) live in the spec YAML —
// `quantile_over_time` over the gauge series.
var (
	blockTimeGauge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l2_block_time_milliseconds",
			Help: "Wall-clock time, in milliseconds, between two consecutive `newHeads` events on a Layer-2 sequencer. One sample per block.",
		},
		[]string{"chain"},
	)

	blockTimeHistogram = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "l2_block_time_milliseconds_histogram",
			Help:    "Histogram of L2 block-time samples per chain — drives the p50/p90/p99 leaderboard via histogram_quantile.",
			Buckets: []float64{50, 100, 200, 500, 1000, 2000, 3000, 5000, 7500, 10000, 20000, 30000, 60000},
		},
		[]string{"chain"},
	)

	blockTimeHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l2_block_time_health",
			Help: "1 when the WS subscription is currently connected and receiving newHeads events, 0 otherwise.",
		},
		[]string{"chain"},
	)

	blockTimeSampleCtr = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "l2_block_time_samples_total",
			Help: "Number of newHeads samples observed per chain since process start.",
		},
		[]string{"chain"},
	)

	blockTimeReconnectCtr = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "l2_block_time_reconnects_total",
			Help: "Number of WS reconnections per chain since process start. Sustained non-zero rate signals an unstable upstream.",
		},
		[]string{"chain"},
	)
)

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("l2-block-time harness · OpenChainBench № 009"))
	})
	return http.ListenAndServe(addr, mux)
}
