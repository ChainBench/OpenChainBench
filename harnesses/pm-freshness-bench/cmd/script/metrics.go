package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var commonLabels = prometheus.Labels{"benchmark": "pm-freshness"}

var (
	// Freshness delta vs Polymarket T0, in ms. Buckets sized for sub-second
	// to ~30s lag (Codex p50 is around 4s).
	freshnessDelta = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:        "pm_freshness_delta_ms",
		Help:        "Per-event delta in ms between provider arrival and venue T0 arrival, matched by (conditionId, price, time-bucket, venue).",
		Buckets:     []float64{10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000},
		ConstLabels: commonLabels,
	}, []string{"provider", "venue", "kind"})

	eventsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "pm_events_total",
		Help:        "Raw events received per provider/venue/kind.",
		ConstLabels: commonLabels,
	}, []string{"provider", "venue", "kind"})

	matchedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "pm_matched_total",
		Help:        "Provider events that matched a venue T0 event by signature.",
		ConstLabels: commonLabels,
	}, []string{"provider", "venue", "kind"})

	fetchErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "pm_fetch_errors_total",
		Help:        "Provider errors (connection, auth, parse).",
		ConstLabels: commonLabels,
	}, []string{"provider", "venue", "error_type"})

	health = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name:        "pm_health",
		Help:        "1 if the (provider, venue) published at least one event in the last 60s.",
		ConstLabels: commonLabels,
	}, []string{"provider", "venue"})

	basketSize = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name:        "pm_basket_size",
		Help:        "Number of markets currently subscribed per venue.",
		ConstLabels: commonLabels,
	}, []string{"venue"})
)

func startMetricsServer(addr, logsToken string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	setupLogsEndpoint(mux, logsToken)
	return http.ListenAndServe(addr, mux)
}
