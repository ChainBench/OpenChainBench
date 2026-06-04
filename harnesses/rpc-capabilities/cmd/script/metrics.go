package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB public RPC capabilities bench. Names follow
// the `rpc_<measurement>_<unit>` convention used by every other OCB
// harness; the spec YAML uses these directly via PromQL.
//
// Three concerns are emitted from one binary because they share the
// same set of (provider × chain) clients and same scrape interval —
// splitting them across services would triple the Railway footprint
// without reducing complexity.
var (
	rpcLatency = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_latency_milliseconds",
			Help: "Latest observed HTTP round-trip in milliseconds for `eth_blockNumber` against a public RPC endpoint.",
		},
		[]string{"provider", "chain"},
	)

	rpcLatencyHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "rpc_latency_milliseconds_histogram",
			Help:    "Histogram of public RPC `eth_blockNumber` latencies — drives the p50/p90/p99 leaderboard via `histogram_quantile` / `quantile_over_time`.",
			Buckets: []float64{50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000},
		},
		[]string{"provider", "chain"},
	)

	rpcCallTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_call_total",
			Help: "Number of RPC calls broken down by result classification: ok, http_err (status != 200 or transport failure), jsonrpc_err (HTTP 200 with `error` field — Ankr/Cloudflare-eth trap), stale (block more than 20 behind cross-provider tip), timeout.",
		},
		[]string{"provider", "chain", "result"},
	)

	rpcHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_health",
			Help: "1 when the most recent latency probe returned a fresh, valid block, 0 otherwise.",
		},
		[]string{"provider", "chain"},
	)

	rpcArchiveDepth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_archive_depth_supported",
			Help: "1 if `eth_getBalance` at (head - depth) returns a non-pruned response, 0 otherwise. depth label is in blocks. The set {300, 7200, 216000, 1296000, 5000000} covers Geth's default pruned cap up through genesis-era full archive.",
		},
		[]string{"provider", "chain", "depth"},
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
		_, _ = w.Write([]byte("rpc-capabilities harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
