package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Mirrors the solana-quote-latency metric family but with a `chain` label
// baked in from day 1 since this harness runs across multiple EVM chains.
// Metric prefix is `evm_swap_quote_*` so the families never collide with
// `solana_quote_*` and the bench page can query each independently.
var (
	quoteLatencyMs  *prometheus.HistogramVec
	quoteSuccess    *prometheus.GaugeVec
	quoteThrottled  *prometheus.CounterVec
	quoteAuthError  *prometheus.CounterVec
	quoteNoRoute    *prometheus.CounterVec
	quoteOtherError *prometheus.CounterVec
)

func init() {
	quoteLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "evm_swap_quote_latency_ms",
			Help:    "EVM swap quote API latency in milliseconds (successful quotes only)",
			Buckets: []float64{10, 25, 50, 100, 200, 500, 1000, 2000, 5000},
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteLatencyMs)

	quoteSuccess = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "evm_swap_quote_success",
			Help: "Last probe outcome per provider (1 = success, 0 = failure)",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteSuccess)

	quoteThrottled = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_throttled_total",
			Help: "Total HTTP 429 responses per provider",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteThrottled)

	quoteAuthError = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_auth_error_total",
			Help: "Total HTTP 401/403 responses per provider",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteAuthError)

	quoteNoRoute = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_no_route_total",
			Help: "Total times a provider returned no route for the requested pair",
		},
		[]string{"provider", "chain", "region"},
	)
	prometheus.MustRegister(quoteNoRoute)

	quoteOtherError = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "evm_swap_quote_other_error_total",
			Help: "Total non-auth, non-throttle, non-no-route errors per provider (network, timeout, parse, non-2xx)",
		},
		[]string{"provider", "chain", "region", "error_type"},
	)
	prometheus.MustRegister(quoteOtherError)
}

func RecordLatency(provider, chain, region string, latencyMs int64) {
	quoteLatencyMs.WithLabelValues(provider, chain, region).Observe(float64(latencyMs))
	quoteSuccess.WithLabelValues(provider, chain, region).Set(1)
}
func RecordThrottled(provider, chain, region string) {
	quoteThrottled.WithLabelValues(provider, chain, region).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}
func RecordAuthError(provider, chain, region string) {
	quoteAuthError.WithLabelValues(provider, chain, region).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}
func RecordNoRoute(provider, chain, region string) {
	quoteNoRoute.WithLabelValues(provider, chain, region).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}
func RecordOtherError(provider, chain, region, errorType string) {
	quoteOtherError.WithLabelValues(provider, chain, region, errorType).Inc()
	quoteSuccess.WithLabelValues(provider, chain, region).Set(0)
}

// StartMetricsServer exposes /metrics, /logs, /healthz on the OCB convention :2112.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	setupLogsEndpoint(mux)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	return http.ListenAndServe(addr, mux)
}

