package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var commonLabels = prometheus.Labels{"benchmark": "wallet-labels"}

// Provider check counters / latency histograms.
// `chain` is the chain the address lives on (solana, ethereum, base, bnb, ...).
// `provider` is the labeling vendor.
var (
	checksTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "wallet_labels_checks_total",
		Help:        "Total label checks attempted per provider/chain/kind.",
		ConstLabels: commonLabels,
	}, []string{"provider", "chain", "kind"})

	successTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "wallet_labels_success_total",
		Help:        "Checks where the provider returned a non-generic entity label.",
		ConstLabels: commonLabels,
	}, []string{"provider", "chain", "kind"})

	apiLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:        "wallet_labels_api_latency_milliseconds",
		Help:        "Provider API response time in milliseconds.",
		Buckets:     []float64{50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000},
		ConstLabels: commonLabels,
	}, []string{"provider"})

	fetchErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "wallet_labels_fetch_errors_total",
		Help:        "Provider request errors.",
		ConstLabels: commonLabels,
	}, []string{"provider", "error_type"})

	health = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name:        "wallet_labels_health",
		Help:        "1 if the provider responded successfully on its last check; 0 otherwise.",
		ConstLabels: commonLabels,
	}, []string{"provider"})

	queueDepth = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "wallet_labels_queue_depth",
		Help:        "Pending wallet checks in the queue.",
		ConstLabels: commonLabels,
	})
)

func recordCheck(provider, chain, kind string, hasLabel bool, latencyMs float64, err error) {
	if kind == "" {
		kind = "unknown"
	}
	checksTotal.WithLabelValues(provider, chain, kind).Inc()
	apiLatency.WithLabelValues(provider).Observe(latencyMs)
	if err != nil {
		fetchErrors.WithLabelValues(provider, classifyErr(err)).Inc()
		health.WithLabelValues(provider).Set(0)
		return
	}
	health.WithLabelValues(provider).Set(1)
	if hasLabel {
		successTotal.WithLabelValues(provider, chain, kind).Inc()
	}
}

func classifyErr(err error) string {
	if err == nil {
		return "none"
	}
	s := err.Error()
	switch {
	case contains(s, "timeout"):
		return "timeout"
	case contains(s, "429"):
		return "rate_limit"
	case contains(s, "401") || contains(s, "403"):
		return "auth"
	case contains(s, "500") || contains(s, "502") || contains(s, "503"):
		return "server"
	default:
		return "other"
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// startMetricsServer exposes /metrics, /logs, /debug/wallet-labels.
func startMetricsServer(addr, _ string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	setupDebugEndpoint(mux)
	return http.ListenAndServe(addr, mux)
}
