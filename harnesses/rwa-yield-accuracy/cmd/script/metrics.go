package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// All series carry {issuer, token, chain} so the bench spec can select
// per-token and the site can aggregate per-issuer or per-chain
// downstream without cardinality tricks.

var (
	promisedBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_promised_bps",
		Help: "Advertised APY in basis points, sourced from the issuer's public dashboard. Reloaded from promised-yields.yml every 60 seconds so a manual weekly update lands within one scrape cycle.",
	}, []string{"issuer", "token", "chain"})

	deliveredBps30d = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_delivered_bps_30d",
		Help: "Delivered yield over a rolling 30-day window, annualized, in basis points. Derived per issuer from the token's own distribution mechanism (rebase, USDC dividend Transfer events, or NAV appreciation).",
	}, []string{"issuer", "token", "chain"})

	deliveredBps7d = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_delivered_bps_7d",
		Help: "Delivered yield over a rolling 7-day window, annualized. Same computation as 30d, shorter window for volatility context.",
	}, []string{"issuer", "token", "chain"})

	deliveredBpsLifetime = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_delivered_bps_lifetime",
		Help: "Delivered yield since token inception, annualized. The honest cross-issuer comparison, unaffected by short-window distribution cycles that undersample monthly dividend tokens.",
	}, []string{"issuer", "token", "chain"})

	deviationBps30d = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_deviation_bps_30d",
		Help: "delivered_bps_30d minus promised_bps. Sign preserved: negative means the token paid less than advertised over the window, positive means more.",
	}, []string{"issuer", "token", "chain"})

	deviationBps7d = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_deviation_bps_7d",
		Help: "delivered_bps_7d minus promised_bps.",
	}, []string{"issuer", "token", "chain"})

	deviationBpsLifetime = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_deviation_bps_lifetime",
		Help: "delivered_bps_lifetime minus promised_bps.",
	}, []string{"issuer", "token", "chain"})

	totalSupply = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_total_supply_units",
		Help: "Current totalSupply of the token in its own units (BUIDL: 1e18 wei, USDY: 1e18 wei, etc.). Useful for context and for verifying probe health across restarts.",
	}, []string{"issuer", "token", "chain"})

	aumUSD = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_aum_usd",
		Help: "Approximate AUM in USD. totalSupply times share price. For BUIDL/USTB share price is $1 by design; for USDY it is the rebase-inflated share; for BENJI/OUSG it is the NAV.",
	}, []string{"issuer", "token", "chain"})

	probeOK = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_probe_ok",
		Help: "1 if the most recent on-chain probe returned a valid measurement, 0 if it failed.",
	}, []string{"issuer", "token", "chain"})

	lastMeasured = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "rwa_yield_last_measured_unix",
		Help: "Unix timestamp of the last successful on-chain read for this token.",
	}, []string{"issuer", "token", "chain"})

	probeErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "rwa_yield_probe_errors_total",
		Help: "Count of probe failures by error type: rpc_err, parse_err, timeout, contract_err, nav_source_err.",
	}, []string{"issuer", "token", "chain", "error_type"})

	distributionsUSD = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "rwa_yield_distributions_usd_total",
		Help: "Cumulative USDC-equivalent distributions counted from on-chain Transfer events since the harness started. Dividend-model tokens only; rebase/NAV tokens report zero here.",
	}, []string{"issuer", "token", "chain"})
)

// StartMetricsServer binds /metrics + /health + /logs on addr. Blocking
// call, run in its own goroutine.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("rwa-yield-accuracy harness · OpenChainBench № 089"))
	})
	return http.ListenAndServe(addr, mux)
}
