package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	coverageSuccess  *prometheus.CounterVec
	coverageAttempts *prometheus.CounterVec
	coverageAPIok    *prometheus.CounterVec
)

func init() {
	coverageSuccess = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "token_quote_coverage_success_total",
			Help: "Number of successful quote probes (outAmount > 0) per provider/venue/chain",
		},
		[]string{"provider", "venue", "chain"},
	)
	prometheus.MustRegister(coverageSuccess)

	coverageAttempts = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "token_quote_coverage_attempts_total",
			Help: "Total quote probe attempts per provider/venue/chain",
		},
		[]string{"provider", "venue", "chain"},
	)
	prometheus.MustRegister(coverageAttempts)

	coverageAPIok = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "token_quote_api_ok_total",
			Help: "HTTP 200 responses received per provider/venue/chain, regardless of outAmount",
		},
		[]string{"provider", "venue", "chain"},
	)
	prometheus.MustRegister(coverageAPIok)
}

// RecordProbeDetailed records one probe: apiOk=true when the provider returned HTTP 200,
// routeFound=true when outAmount > 0 was parsed from the response.
func RecordProbeDetailed(provider, venue, chain string, apiOk, routeFound bool) {
	coverageAttempts.WithLabelValues(provider, venue, chain).Inc()
	if apiOk {
		coverageAPIok.WithLabelValues(provider, venue, chain).Inc()
	}
	if routeFound {
		coverageSuccess.WithLabelValues(provider, venue, chain).Inc()
	}
}

// StartMetricsServer exposes /metrics, /logs, /healthz on :2112.
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
