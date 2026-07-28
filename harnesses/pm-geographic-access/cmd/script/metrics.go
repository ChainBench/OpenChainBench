package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// pm_geo_accessible{venue, region} = 1 if the venue's public market
	// listing endpoint returned HTTP 200 from the probe region, 0 otherwise.
	// Probe frequency: every 15 minutes.
	pmGeoAccessible = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_geo_accessible",
			Help: "1 if the venue's public market listing endpoint returned HTTP 200 from the probe region, 0 if blocked (403), redirected to a block page, or timed out. Probed every 15 minutes. Does not assess legal access rights.",
		},
		[]string{"venue", "region"},
	)

	pmGeoLastRefresh = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "pm_geo_last_refresh_seconds",
			Help: "Unix timestamp of the last probe attempt per venue and region.",
		},
		[]string{"venue", "region"},
	)

	pmGeoProbeTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "pm_geo_probe_total",
			Help: "Total probe attempts per venue and region.",
		},
		[]string{"venue", "region"},
	)

	pmGeoFetchErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "pm_geo_fetch_errors_total",
			Help: "Total probe failures (network errors, timeouts) per venue and error type.",
		},
		[]string{"venue", "error_type"},
	)
)

func init() {
	prometheus.MustRegister(pmGeoAccessible, pmGeoLastRefresh, pmGeoProbeTotal, pmGeoFetchErrors)
}

func StartMetricsServer(addr string) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("OK"))
	})
	return http.ListenAndServe(addr, mux)
}
