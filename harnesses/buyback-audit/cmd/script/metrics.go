package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prom metrics for the OCB Buyback Execution Audit bench (#018).
// We expose, per protocol + window:
//   - promised_usd: the dollar amount the protocol *should* have spent on
//     buybacks given its stated rule (e.g. Hyperliquid 97 % of fees,
//     GMX-v2 27 % of fees, Sky SBE deterministic from surplus).
//   - executed_usd: the dollar amount actually observed on-chain
//     (Assistance Fund spend for Hyperliquid, treasury outflows for GMX,
//     surplus burn for Sky/Maker).
//   - ratio: executed / promised. 1.0 means the protocol honored its
//     stated buyback policy over the window. < 1.0 means under-execution.
//
// All gauges carry a `protocol` label and (where relevant) a `window`
// label so the leaderboard YAML can do PromQL slicing.
var (
	buybackExecutedUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_buyback_executed_usd",
			Help: "USD value of buybacks actually executed on-chain over the window.",
		},
		[]string{"protocol", "window"},
	)

	buybackPromisedUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_buyback_promised_usd",
			Help: "USD value of buybacks the protocol promised over the window (e.g. fee_share * revenue).",
		},
		[]string{"protocol", "window"},
	)

	buybackRatio = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_buyback_ratio",
			Help: "executed_usd / promised_usd over the window. 1.0 = full execution.",
		},
		[]string{"protocol", "window"},
	)

	buybackScrapeErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ocb_buyback_scrape_errors_total",
			Help: "Total number of scrape errors broken down by protocol and upstream source (hyperliquid_info, etherscan, defillama, coingecko).",
		},
		[]string{"protocol", "source"},
	)

	buybackLastScrape = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_buyback_last_scrape_timestamp_seconds",
			Help: "Unix timestamp of the last successful scrape for the protocol.",
		},
		[]string{"protocol"},
	)
)

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine. Port :2112 is the OCB convention for every
// harness scraped by the shared Prometheus at
// <service>.railway.internal:2112; never read $PORT.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("buyback-audit harness · OpenChainBench #018"))
	})
	return http.ListenAndServe(addr, mux)
}
