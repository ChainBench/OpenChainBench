package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// pm_fee_taker_bps{venue} is the effective taker fee in basis points
	// of gross notional ($1 resolution value per contract).
	//
	// Static venues (set once at startup):
	//   polymarket = 200 bps  (flat 2% of potential payout)
	//   kalshi     = 700 bps  (approx $0.07/contract at $0.50; from published schedule)
	//   manifold   = 0 bps    (play-money, no real fee)
	//   myriad     = 200 bps  (2% protocol settlement fee)
	//
	// Live venue (refreshed hourly):
	//   limitless  = median half-spread across active USDC markets (from tradePrices API)
	pmFeeTakerBps = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_fee_taker_bps",
			Help: "Effective taker fee in basis points of gross notional ($1 resolution value per contract). Polymarket=200 (2% of payout, flat). Kalshi=700 (approx $0.07/contract at ATM, from published schedule). Limitless=live median half-spread across active USDC markets. Manifold=0 (play-money). Myriad=200 (2% settlement protocol fee).",
		},
		[]string{"venue"},
	)

	pmFeeLastRefresh = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_fee_last_refresh_seconds",
			Help: "Unix timestamp of the last successful fee measurement per venue.",
		},
		[]string{"venue"},
	)

	pmFeeFetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "pm_fee_fetch_errors_total",
			Help: "Total fetch failures per venue and error type.",
		},
		[]string{"venue", "error_type"},
	)
)

func init() {
	prometheus.MustRegister(pmFeeTakerBps, pmFeeLastRefresh, pmFeeFetchErrors)
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
