package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// pmapi_* namespace: prediction-market venue APIs probed directly (native
// gateways), distinct from pm_* (pm-freshness, data providers). Latency
// histograms only record successful requests; failures land in
// pmapi_requests_total{outcome} so failure modes never pollute the
// latency aggregates.
var (
	durBuckets     = []float64{0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.4, 0.6, 1, 1.5, 2.5, 4, 6, 10}
	connectBuckets = []float64{0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6, 1, 1.5, 2.5}

	reqDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pmapi_request_duration_seconds",
		Help:    "Full HTTP round-trip (incl. body) for successful probes against prediction-market venue APIs. conn=warm reuses a keep-alive pool, conn=cold forces a fresh TCP+TLS handshake. cache=hit means the response was served by a CDN edge, not the venue origin. source=direct probes the native venue gateway; source=mobula|predexon|codex probes the same logical venue via an aggregator.",
		Buckets: durBuckets,
	}, []string{"venue", "class", "region", "conn", "cache", "source"})

	reqTTFB = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pmapi_request_ttfb_seconds",
		Help:    "Time to first response byte for successful probes. Compare with duration to separate server time from payload size (payloads range 17 B to 650 KB across classes).",
		Buckets: durBuckets,
	}, []string{"venue", "class", "region", "conn", "cache", "source"})

	reqConnect = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pmapi_request_connect_seconds",
		Help:    "TCP+TLS handshake time on the dedicated cold-connect probe (1/min per venue, keep-alives disabled).",
		Buckets: connectBuckets,
	}, []string{"venue", "region", "source"})

	reqTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pmapi_requests_total",
		Help: "Probe outcomes: ok, timeout, http_4xx, http_5xx, throttled (429), probe_invalid (our pinned market went stale, e.g. Limitless CDN-cached 400 on an expired market — never counted against the venue), net_error.",
	}, []string{"venue", "class", "region", "conn", "outcome", "source"})

	bookStaleness = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pmapi_book_staleness_seconds",
		Help: "Server-reported data age: now minus the timestamp the venue embeds in its book/market payload. Only Polymarket (book.timestamp) and Manifold (lastUpdatedTime) expose one; the absence elsewhere is itself a finding.",
	}, []string{"venue", "region", "source"})

	venueHealth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pmapi_health",
		Help: "1 when the most recent primary-class probe returned ok, 0 otherwise.",
	}, []string{"venue", "region", "source"})

	wsConnectToSnapshot = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pmapi_ws_connect_to_snapshot_seconds",
		Help:    "Time from WebSocket dial to the first market data frame after subscribing. Kalshi requires auth for WS and Myriad has none, so only venues with a public WS appear.",
		Buckets: durBuckets,
	}, []string{"venue", "region", "source"})

	wsInterarrival = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pmapi_ws_update_interarrival_seconds",
		Help:    "Gap between consecutive market data frames on the public WebSocket for the pinned market.",
		Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120},
	}, []string{"venue", "region", "source"})

	wsDisconnects = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pmapi_ws_disconnects_total",
		Help: "WebSocket connections dropped after being established.",
	}, []string{"venue", "region", "source"})

	rampDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "pmapi_ramp_request_duration_seconds",
		Help:    "Round-trip during the daily rate-limit ramp, by tier (requests per 10 s window). Successful requests only.",
		Buckets: durBuckets,
	}, []string{"venue", "region", "tier", "source"})

	rampTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "pmapi_ramp_requests_total",
		Help: "Ramp request outcomes per tier. throttled+5xx above 1% of a 10 s window aborts the ramp for that venue.",
	}, []string{"venue", "region", "tier", "outcome", "source"})

	rampAdded = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "pmapi_ramp_added_latency_seconds",
		Help: "p50(tier) minus p50(warm book baseline over the previous hour, same region). Venues that queue under load (e.g. Cloudflare in front of Polymarket) show added latency without ever returning 429, so this is the honest throttle signal.",
	}, []string{"venue", "region", "tier", "source"})
)

// sourceDirect is the label value stamped on every direct (native venue
// gateway) probe. Aggregator probes pass "mobula", "predexon", "codex".
const sourceDirect = "direct"

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
		_, _ = w.Write([]byte("pm-rate-limits harness · OpenChainBench"))
	})
	return http.ListenAndServe(addr, mux)
}
