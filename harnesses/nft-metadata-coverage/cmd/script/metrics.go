package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// nft_metadata_* namespace: NFT collection-level metadata coverage across the
// 4 indexers we audit (Moralis / Alchemy / OpenSea / Rarible). The denominator
// (checks_total) intentionally EXCLUDES the {Rarible, floor_eth} pair because
// Rarible's collection endpoint only exposes a bid-side floor (bestBidOrder),
// not an ask-side floor — counting it would unfairly punish them on apples-to-
// apples scoring vs the 3 providers that DO expose an ask floor.
var (
	latencyBuckets = []float64{50, 100, 200, 500, 1000, 2000, 5000, 10000}

	checksTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nft_metadata_checks_total",
		Help: "Total per-field metadata checks performed. The {provider=rarible, field=floor_eth} series is deliberately never incremented (Rarible exposes only a bid floor, not an ask floor).",
	}, []string{"provider", "collection", "field", "region"})

	successTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nft_metadata_success_total",
		Help: "Per-field successes (value is a non-empty string or a positive number).",
	}, []string{"provider", "collection", "field", "region"})

	latencyMs = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "nft_metadata_latency_milliseconds",
		Help:    "Wall-clock latency per provider request (collection metadata fetch). OpenSea aggregates both calls (collection + stats).",
		Buckets: latencyBuckets,
	}, []string{"provider", "region"})

	errorsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "nft_metadata_errors_total",
		Help: "Per-provider errors classified by type: timeout, http_4xx, http_5xx, not_found (404), parse_error, request_error, slug_resolve_error, throttled (429).",
	}, []string{"provider", "error_type", "region"})
)

// recordFieldChecks updates checks_total + success_total for every field on a
// single provider response. The Rarible floor exception is enforced upstream
// (see rarible.go which skips the floor_eth field entirely).
func recordFieldChecks(provider, collection, region string, fields map[string]bool) {
	for field, present := range fields {
		checksTotal.WithLabelValues(provider, collection, field, region).Inc()
		if present {
			successTotal.WithLabelValues(provider, collection, field, region).Inc()
		}
	}
}

func recordLatency(provider, region string, ms float64) {
	if ms < 0 {
		return
	}
	latencyMs.WithLabelValues(provider, region).Observe(ms)
}

func recordError(provider, region, errorType string) {
	errorsTotal.WithLabelValues(provider, errorType, region).Inc()
}

// StartMetricsServer binds /metrics + /health + /logs on addr. Blocking call,
// run in its own goroutine. :2112 is the OCB convention; Railway's $PORT is
// deliberately ignored so the shared Prometheus always finds the listener.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/logs", logsHandler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("nft-metadata-coverage harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
