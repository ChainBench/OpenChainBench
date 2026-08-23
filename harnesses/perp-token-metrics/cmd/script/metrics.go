package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	protocolPE = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_pe_ratio",
		Help: "P/E ratio per perp DEX protocol (FDV / annualized 30d avg daily revenue).",
	}, []string{"protocol"})

	protocolFDV = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_fdv_usd",
		Help: "Fully diluted valuation in USD per perp DEX protocol (CoinGecko).",
	}, []string{"protocol"})

	protocolAnnualRev = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_annual_rev_usd",
		Help: "Annualized protocol revenue in USD (DeFiLlama 30d avg x 365).",
	}, []string{"protocol"})

	protocolRev24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_rev_24h_usd",
		Help: "24h protocol revenue in USD (DeFiLlama dailyRevenue).",
	}, []string{"protocol"})

	protocolHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_health",
		Help: "1 if this protocol returned data in the last poll.",
	}, []string{"protocol"})
)

func init() {
	prometheus.MustRegister(
		protocolPE,
		protocolFDV,
		protocolAnnualRev,
		protocolRev24h,
		protocolHealth,
	)
}

func startMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
