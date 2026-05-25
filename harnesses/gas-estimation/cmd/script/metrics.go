package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB gas estimation accuracy bench. All values
// are in **gwei** (not wei) — the float64 representation is fine
// since priority fees on the measured chains span 0.001 gwei
// (Avalanche calm) to 500+ gwei (Polygon spike) and float64 has
// ample precision across that range.
//
// Naming convention `gas_<measurement>_<unit>` matches the rest of
// the OCB suite. The spec YAML uses these directly via PromQL. Every
// metric carries a `chain` label so the leaderboard can filter to
// Ethereum / Polygon / Avalanche or aggregate across all of them.
var (
	gasPredictedPriority = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_predicted_priority_gwei",
			Help: "Most recent priority-fee prediction (gwei) emitted by an oracle for a specific tier. Updated on each oracle poll.",
		},
		[]string{"oracle", "tier", "chain"},
	)

	gasPredictedBase = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_predicted_base_gwei",
			Help: "Most recent next-block base-fee prediction (gwei) emitted by an oracle.",
		},
		[]string{"oracle", "chain"},
	)

	gasRealizedPriority = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_realized_priority_gwei",
			Help: "Realized priority-fee percentile (gwei) computed from the actual transactions in the mined block.",
		},
		[]string{"tier", "chain"},
	)

	gasRealizedBase = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_realized_base_gwei",
			Help: "Realized base fee (gwei) of the most recently observed block.",
		},
		[]string{"chain"},
	)

	gasErrorPriorityGauge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_error_priority_gwei",
			Help: "Latest absolute error (|predicted - realized|, gwei) for the priority-fee tier prediction of a given oracle. One sample per (oracle, tier, chain) per realized block.",
		},
		[]string{"oracle", "tier", "chain"},
	)

	gasErrorPriorityHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gas_error_priority_gwei_histogram",
			Help:    "Histogram of absolute priority-fee prediction errors per (oracle, tier, chain) — drives the p50/p90 leaderboard via `histogram_quantile` / `quantile_over_time`. Buckets span Avalanche-calm (0.001 gwei) up through Polygon-spike (100+ gwei) so the same scale works across every measured chain.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250},
		},
		[]string{"oracle", "tier", "chain"},
	)

	gasErrorBaseGauge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_error_base_gwei",
			Help: "Latest absolute error (|predicted - realized|, gwei) for the next-block base-fee prediction. Most oracles inherit baseFee from EIP-1559 so this is mostly a sanity check, not a ranking signal.",
		},
		[]string{"oracle", "chain"},
	)

	gasOracleCallTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gas_oracle_call_total",
			Help: "Number of oracle polls broken down by result: ok, http_err, parse_err, throttled (HTTP 429 or oracle-specific quota message).",
		},
		[]string{"oracle", "result", "chain"},
	)

	gasOracleHealth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_oracle_health",
			Help: "1 when the most recent poll succeeded, 0 otherwise.",
		},
		[]string{"oracle", "chain"},
	)

	gasRealizedTxCount = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_realized_tx_count",
			Help: "Transaction count of the most recently observed block. Low values (empty blocks) flag that the realized percentile may be noisy.",
		},
		[]string{"chain"},
	)

	gasPendingBufferSize = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "gas_pending_buffer_size",
			Help: "Number of pending predictions for each (oracle, chain) still waiting on a realized block. Sustained growth signals the realizer is falling behind.",
		},
		[]string{"oracle", "chain"},
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
		_, _ = w.Write([]byte("gas-estimation harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
