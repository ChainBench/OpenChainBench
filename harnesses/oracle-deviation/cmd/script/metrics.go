package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB Oracle Deviation bench (№ 025). Naming
// follows the `ocb_oracle_<measurement>` convention; the OCB site
// derives the per-pair / per-source leaderboard directly from these
// gauges via PromQL.
var (
	oraclePrice = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_price",
			Help: "Most recent USD price reported by an oracle for a pair. USDT is treated as ≈ USD (Binance only quotes USDT).",
		},
		[]string{"source", "pair"},
	)

	oracleDeviationPct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_deviation_pct",
			Help: "Pairwise deviation between two sources for the same pair, expressed as percent of the midpoint: |a-b|/((a+b)/2)*100. One sample per (pair, source_a, source_b), source_a < source_b lexicographically to avoid double-counting.",
		},
		[]string{"pair", "source_a", "source_b"},
	)

	oracleMaxDeviationPct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_max_deviation_pct",
			Help: "Maximum pairwise deviation observed across all available source pairs for a given asset pair. The headline metric of this bench.",
		},
		[]string{"pair"},
	)

	oracleUpdateLatencySeconds = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_update_latency_seconds",
			Help: "Seconds since the most recent successful update for (source, pair). Useful to flag a stalled poller before the price drifts.",
		},
		[]string{"source", "pair"},
	)

	oracleScrapeErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ocb_oracle_scrape_errors_total",
			Help: "Number of failed scrape attempts per (source, pair). Bucket-only counter, classification is logged but not labeled to keep cardinality bounded.",
		},
		[]string{"source", "pair"},
	)

	oracleLastRoundAge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_oracle_last_round_age_seconds",
			Help: "Seconds elapsed since the oracle's own internal updatedAt timestamp. Only emitted for sources that expose one (currently Chainlink's latestRoundData.updatedAt).",
		},
		[]string{"source", "pair"},
	)
)

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine. /health returns 200 ok unconditionally;
// the harness considers itself healthy as long as the metrics server
// itself is up — individual source failures are reflected in the
// scrape_errors_total counter, not in the healthcheck.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("oracle-deviation harness · OpenChainBench № 025"))
	})
	return http.ListenAndServe(addr, mux)
}
