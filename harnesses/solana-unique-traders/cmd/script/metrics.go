package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	uniqueTraders24h = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_platform_unique_traders_24h",
		Help: "Unique wallet addresses that traded through this Solana platform in the last 24h (Dune Analytics, fee-wallet attribution).",
	}, []string{"platform"})

	traderHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "solana_platform_trader_health",
		Help: "1 if this platform returned unique-trader data in the last Dune poll.",
	}, []string{"platform"})
)

func init() {
	prometheus.MustRegister(uniqueTraders24h, traderHealth)
}

func publishRows(rows []duneRow) {
	for _, r := range rows {
		if r.Platform == "" {
			continue
		}
		uniqueTraders24h.WithLabelValues(r.Platform).Set(r.UniqueTraders24h)
		traderHealth.WithLabelValues(r.Platform).Set(1)
	}
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
