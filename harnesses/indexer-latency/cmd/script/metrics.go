package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	latencyHist = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "idx_latency_seconds",
			Help:    "Histogram of time-to-queryable lags: seconds between our reference RPC first showing block N and the provider first returning block N's probe event.",
			Buckets: []float64{1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 90, 120, 180, 240, 360, 600},
		},
		[]string{"provider"},
	)

	latencyLast = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "idx_latency_last_seconds",
			Help: "Latest observed time-to-queryable lag per provider (drives the bench page time series).",
		},
		[]string{"provider"},
	)

	probeTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "idx_probe_total",
			Help: "Probe outcomes per provider: found | timeout (not queryable within 240s) | error | quota_paused | disabled (credential missing).",
		},
		[]string{"provider", "result"},
	)

	quotaUsedRatio = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "idx_quota_used_ratio",
			Help: "Fraction of the provider's monthly call budget consumed (probing pauses at 0.90, calendar-month reset).",
		},
		[]string{"provider"},
	)

	health = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "idx_health",
			Help: "1 when the provider's last probe found the event, 0 on timeout/error/disabled. Doubles as the harness freshness signal.",
		},
		[]string{"provider"},
	)

	apiCalls = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "idx_api_calls_total",
			Help: "API calls issued per provider (feeds the monthly quota guard).",
		},
		[]string{"provider"},
	)
)

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}
