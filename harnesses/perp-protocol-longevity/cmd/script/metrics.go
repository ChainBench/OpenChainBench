package main

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	daysCleanGauge       *prometheus.GaugeVec
	incidentsTotalGauge  *prometheus.GaugeVec
	incidentAmountGauge  *prometheus.GaugeVec
	launchDayGauge       *prometheus.GaugeVec
	registryTimestampGauge prometheus.Gauge
	healthGauge          *prometheus.GaugeVec
)

func init() {
	daysCleanGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_days_clean",
		Help: "Days since the last recorded security exploit (or since launch if none). Higher is better.",
	}, []string{"venue"})
	prometheus.MustRegister(daysCleanGauge)

	incidentsTotalGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_incidents_total",
		Help: "Total number of recorded security incidents for this venue per the embedded registry.",
	}, []string{"venue"})
	prometheus.MustRegister(incidentsTotalGauge)

	incidentAmountGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_incident_amount_usd",
		Help: "Cumulative USD lost in recorded security incidents. 0 if none.",
	}, []string{"venue"})
	prometheus.MustRegister(incidentAmountGauge)

	launchDayGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_launch_timestamp_seconds",
		Help: "Unix timestamp of the protocol's mainnet launch date.",
	}, []string{"venue"})
	prometheus.MustRegister(launchDayGauge)

	registryTimestampGauge = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "perp_protocol_registry_last_updated_timestamp_seconds",
		Help: "Unix timestamp when the embedded incident registry was last updated.",
	})
	prometheus.MustRegister(registryTimestampGauge)

	healthGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_protocol_health",
		Help: "Always 1 for this harness (no external calls, computed from embedded registry).",
	}, []string{"venue"})
	prometheus.MustRegister(healthGauge)
}

// registryUpdatedAt is the date the embedded registry was last reviewed.
var registryUpdatedAt = time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)

func publishAll() {
	registryTimestampGauge.Set(float64(registryUpdatedAt.Unix()))
	now := float64(time.Now().Unix())
	for _, vr := range registry {
		streakStart := float64(cleanStreakStart(vr))
		days := (now - streakStart) / 86400
		daysCleanGauge.WithLabelValues(vr.Slug).Set(days)
		incidentsTotalGauge.WithLabelValues(vr.Slug).Set(float64(len(vr.Incidents)))
		incidentAmountGauge.WithLabelValues(vr.Slug).Set(totalIncidentAmount(vr))
		launchDayGauge.WithLabelValues(vr.Slug).Set(float64(vr.Launched.Unix()))
		healthGauge.WithLabelValues(vr.Slug).Set(1)
	}
}

// StartMetricsServer starts the Prometheus /metrics endpoint on addr.
func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
