package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// All gauges are scoped by (chain, validator, name). Yields are
// expressed in **basis points** (1% = 100 bps) so the metric works
// uniformly across Solana (~7-9% APR) and Hyperliquid (~2-4% APR)
// without floating-point quirks at small values.
var (
	validatorNetYieldBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_net_yield_bps",
			Help: "Net validator yield in basis points = gross APR + MEV − downtime drag. Slashing treated as negligible in v1.",
		},
		[]string{"chain", "validator", "name"},
	)

	validatorGrossYieldBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_gross_yield_bps",
			Help: "Gross validator yield (pre-downtime, pre-slashing) in basis points. Includes MEV share where reported.",
		},
		[]string{"chain", "validator", "name"},
	)

	validatorMevShareBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_mev_share_bps",
			Help: "MEV portion of validator yield in basis points. On Solana this is the Jito APY; on Hyperliquid this is 0 (MEV captured by sequencer, not validator).",
		},
		[]string{"chain", "validator", "name"},
	)

	validatorCommissionBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_commission_bps",
			Help: "Validator commission in basis points (the cut taken from delegators).",
		},
		[]string{"chain", "validator", "name"},
	)

	validatorUptimePct = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_uptime_pct",
			Help: "Validator uptime as a percentage (0-100). On Solana derived from skip_rate, on Hyperliquid from nRecentBlocks / max(nRecentBlocks).",
		},
		[]string{"chain", "validator", "name"},
	)

	validatorStakeUSD = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_stake_usd",
			Help: "Validator delegated stake converted to USD at scrape time.",
		},
		[]string{"chain", "validator", "name"},
	)

	validatorJailed = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_jailed",
			Help: "1 when the validator is currently jailed/delinquent, 0 otherwise.",
		},
		[]string{"chain", "validator", "name"},
	)

	chainMedianNetYieldBps = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_chain_median_net_yield_bps",
			Help: "Median validator net yield (bps) across all validators exposed for this chain.",
		},
		[]string{"chain"},
	)

	chainTotalValidators = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_chain_total_validators",
			Help: "Number of validators currently exposed by the harness for this chain (after top-N cap).",
		},
		[]string{"chain"},
	)

	scrapeErrorsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ocb_validator_scrape_errors_total",
			Help: "Cumulative scrape errors by chain and upstream source.",
		},
		[]string{"chain", "source"},
	)

	lastScrapeTimestamp = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "ocb_validator_last_scrape_timestamp_seconds",
			Help: "Unix timestamp of the last successful scrape for this chain.",
		},
		[]string{"chain"},
	)
)

// StartMetricsServer binds /metrics + /health on addr. Blocking call —
// run in its own goroutine. Port is hardcoded :2112 at the caller
// (OCB Railway convention; Prometheus scrapes <svc>.railway.internal:2112).
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("validator-economics harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
