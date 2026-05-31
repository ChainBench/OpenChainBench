package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	quoteLatencyMs    *prometheus.HistogramVec
	quoteSuccess      *prometheus.GaugeVec
	quoteThrottled    *prometheus.CounterVec
	quoteAuthError    *prometheus.CounterVec
	quoteOtherError   *prometheus.CounterVec
)

func init() {
	quoteLatencyMs = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "solana_quote_latency_ms",
			Help:    "Solana DEX quote API latency in milliseconds (successful quotes only)",
			Buckets: []float64{10, 25, 50, 100, 200, 500, 1000, 2000, 5000},
		},
		[]string{"provider", "region"},
	)
	prometheus.MustRegister(quoteLatencyMs)

	quoteSuccess = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "solana_quote_success",
			Help: "Last probe outcome per provider (1 = success, 0 = failure)",
		},
		[]string{"provider", "region"},
	)
	prometheus.MustRegister(quoteSuccess)

	quoteThrottled = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_quote_throttled_total",
			Help: "Total HTTP 429 responses per provider",
		},
		[]string{"provider", "region"},
	)
	prometheus.MustRegister(quoteThrottled)

	quoteAuthError = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_quote_auth_error_total",
			Help: "Total HTTP 401/403 responses per provider",
		},
		[]string{"provider", "region"},
	)
	prometheus.MustRegister(quoteAuthError)

	quoteOtherError = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "solana_quote_other_error_total",
			Help: "Total non-auth, non-throttle errors per provider (network, timeout, parse, non-2xx)",
		},
		[]string{"provider", "region", "error_type"},
	)
	prometheus.MustRegister(quoteOtherError)
}

// RecordLatency observes a successful quote latency.
// Caller MUST NOT call this on auth / throttle / parse failures.
func RecordLatency(provider, region string, latencyMs int64) {
	quoteLatencyMs.WithLabelValues(provider, region).Observe(float64(latencyMs))
}

func RecordSuccess(provider, region string, ok bool) {
	v := 0.0
	if ok {
		v = 1.0
	}
	quoteSuccess.WithLabelValues(provider, region).Set(v)
}

func RecordThrottled(provider, region string) {
	quoteThrottled.WithLabelValues(provider, region).Inc()
}

func RecordAuthError(provider, region string) {
	quoteAuthError.WithLabelValues(provider, region).Inc()
}

func RecordOtherError(provider, region, errorType string) {
	quoteOtherError.WithLabelValues(provider, region, errorType).Inc()
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	setupLogsEndpoint(mux)
	return http.ListenAndServe(addr, mux)
}
