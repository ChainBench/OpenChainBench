package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// Headline: absolute deviation of the onchain pool price from the
	// Yahoo reference, in basis points, labeled with the market session
	// the sample was taken in. The bench pins its ranking to
	// market_state="regular"; the closed-state series is the weekend /
	// overnight drift panel.
	tspDeviationBps = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_deviation_bps",
		Help: "Absolute onchain vs reference price deviation per tokenized stock, in bps, labeled by market session state.",
	}, []string{"asset", "market_state", "issuer"})

	tspPriceOnchain = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_price_onchain_usdg",
		Help: "Venue spot price of the tokenized stock, in the venue quote stable.",
	}, []string{"asset", "issuer"})

	tspPriceReference = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_price_reference_usd",
		Help: "Reference equity price from Yahoo Finance (regularMarketPrice; last close when the market is closed).",
	}, []string{"asset"})

	tspRefAge = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_reference_age_seconds",
		Help: "Age of the reference price sample (now minus regularMarketTime). Large outside regular hours by design.",
	}, []string{"asset"})

	tspMarketState = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_market_session",
		Help: "1 for the currently active market session label, 0 otherwise.",
	}, []string{"market_state"})

	tspSourceLatency = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_source_latency_milliseconds",
		Help: "Round-trip latency of the last fetch per source.",
	}, []string{"source"})

	tspSourceCall = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tsp_source_call_total",
		Help: "Fetch outcomes per source (onchain batch, yahoo spark, yahoo chart).",
	}, []string{"source", "result"})

	tspHealth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_health",
		Help: "1 when the last tick produced a deviation sample for the asset, 0 otherwise.",
	}, []string{"asset"})
)

func startMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
