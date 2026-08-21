package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	platformVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_volume_24h_usd",
		Help: "24h trading volume in USD per platform, summed across all blockchains (Sacha's Dune community datasets).",
	}, []string{"platform"})

	platformHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "dune_platform_volume_health",
		Help: "1 if this platform returned volume data in the last Dune poll.",
	}, []string{"platform"})
)

func init() {
	prometheus.MustRegister(platformVolume, platformHealth)
}

func publishRows(rows []duneRow) {
	for _, r := range rows {
		if r.Platform == "" {
			continue
		}
		platformVolume.WithLabelValues(r.Platform).Set(r.VolumeUSD)
		platformHealth.WithLabelValues(r.Platform).Set(1)
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
