package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metric names intentionally match the no-key rpc-capabilities harness
// so the shared Prometheus recording rules (ocb:rpc_latency_*) pick up
// keyed providers with zero rule changes. The `tier="keyed"` label
// disambiguates: no series collision is possible today because provider
// slugs are disjoint between the two harnesses (infura/alchemy/… vs
// publicnode/drpc/…). If a provider ever appears in BOTH tiers, its
// keyed slug must stay distinct (e.g. `drpc-free-tier`) — the per-chain
// no-key bench formulas select providers by exact slug.
var (
	rpcLatency = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_latency_milliseconds",
			Help: "Latest observed HTTP round-trip in milliseconds for `eth_getBlockByNumber(latest)` (EVM) / `getSlot` (Solana) against a keyed free-tier RPC endpoint.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	rpcLatencyHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "rpc_latency_milliseconds_histogram",
			Help:    "Histogram of keyed free-tier RPC probe latencies — drives p50/p90/p99 via `quantile_over_time`.",
			Buckets: []float64{50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000},
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	rpcCallTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "rpc_call_total",
			Help: "Keyed RPC probe outcomes: ok | http_err | jsonrpc_err | stale | timeout | quota_paused.",
		},
		[]string{"provider", "chain", "region", "result", "tier"},
	)

	rpcHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_health",
			Help: "1 when the last keyed probe was fresh + valid, 0 otherwise.",
		},
		[]string{"provider", "chain", "region", "tier"},
	)

	quotaUsedRatio = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "rpc_keyed_quota_used_ratio",
			Help: "Fraction of this region's monthly request budget consumed per provider (probing pauses at 0.90).",
		},
		[]string{"provider", "region"},
	)
)

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
