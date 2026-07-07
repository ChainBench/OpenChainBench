package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	freshnessSeconds = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "indexing_freshness_seconds",
			Help: "Latest observed lag between an organic on-chain tx confirmation and the moment the provider's wallet API first returns it.",
		},
		[]string{"provider", "chain"},
	)

	freshnessHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "indexing_freshness_seconds_histogram",
			Help:    "Histogram of wallet-API indexing freshness lags — drives p50/p90 via quantile_over_time.",
			Buckets: []float64{1, 2, 3, 4, 6, 8, 11, 15, 20, 26, 34, 45, 60, 80, 100, 120},
		},
		[]string{"provider", "chain"},
	)

	probeTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "indexing_probe_total",
			Help: "Probe outcomes per provider: found | missed (not indexed within 120s) | api_error | quota_paused.",
		},
		[]string{"provider", "chain", "result"},
	)

	apiCalls = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "indexing_api_calls_total",
			Help: "API calls issued per provider (feeds the monthly quota guard).",
		},
		[]string{"provider"},
	)

	quotaUsedRatio = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "indexing_quota_used_ratio",
			Help: "Fraction of the provider's monthly call budget consumed (probing pauses at 0.90).",
		},
		[]string{"provider"},
	)
)

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
