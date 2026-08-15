package main

// metrics.go — all Prometheus collectors plus small update helpers so the
// rest of the code never touches label plumbing directly.

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	liqRate = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_rate_24h_pct",
		Help: "Liquidated notional over the trailing 24h as a percentage of open interest (liq_usd / oi_usd * 100).",
	}, []string{"venue", "chain"})

	liqVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_volume_24h_usd",
		Help: "Sum of liquidated notional (USD) over the trailing 24h sliding window.",
	}, []string{"venue", "chain"})

	liqOpenInterest = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_usd",
		Help: "Current open interest (USD) per venue and asset (TVL proxy for venues without a native OI endpoint).",
	}, []string{"venue", "chain"})

	liqWarmingUp = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_warming_up",
		Help: "1 until 24h have elapsed since the venue's first tick (24h sums incomplete before that), else 0.",
	}, []string{"venue"})

	liqHealth = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_health",
		Help: "1 if all fetches for the venue succeeded on the most recent tick, else 0.",
	}, []string{"venue"})

	liqLastRefresh = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_last_refresh_timestamp_seconds",
		Help: "Unix timestamp of the last fully successful tick for the venue.",
	}, []string{"venue"})

	liqFetchErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "perp_liq_fetch_errors_total",
		Help: "Fetch/decode errors per venue, asset and error type.",
	}, []string{"venue", "chain", "error_type"})
)

// registerMetrics builds a dedicated registry containing only this
// exporter's collectors.
func registerMetrics() *prometheus.Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		liqRate,
		liqVolume,
		liqOpenInterest,
		liqWarmingUp,
		liqHealth,
		liqLastRefresh,
		liqFetchErrors,
	)
	return reg
}

// metricsHandler returns the /metrics HTTP handler for the registry.
func metricsHandler(reg *prometheus.Registry) http.Handler {
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}

// setLiqVolume publishes the 24h liquidation volume for a venue/asset.
func setLiqVolume(venue, asset string, volumeUSD float64) {
	liqVolume.WithLabelValues(venue, asset).Set(volumeUSD)
}

// setOIAndRate publishes open interest and, given the current window sum,
// the liquidation rate. Callers must only invoke this with oiUSD > 0.
func setOIAndRate(venue, asset string, volumeUSD, oiUSD float64) {
	liqOpenInterest.WithLabelValues(venue, asset).Set(oiUSD)
	liqRate.WithLabelValues(venue, asset).Set(volumeUSD / oiUSD * 100)
}

// recordFetchError increments the error counter with a classified type.
func recordFetchError(venue, asset, errType string) {
	liqFetchErrors.WithLabelValues(venue, asset, errType).Inc()
}

// setVenueHealth publishes venue health (1 healthy / 0 degraded).
func setVenueHealth(venue string, healthy bool) {
	v := 0.0
	if healthy {
		v = 1.0
	}
	liqHealth.WithLabelValues(venue).Set(v)
}

// setVenueWarming publishes the warm-up flag for the venue.
func setVenueWarming(venue string, warming bool) {
	v := 0.0
	if warming {
		v = 1.0
	}
	liqWarmingUp.WithLabelValues(venue).Set(v)
}

// setVenueRefreshed stamps the last fully successful tick time.
func setVenueRefreshed(venue string, t time.Time) {
	liqLastRefresh.WithLabelValues(venue).Set(float64(t.Unix()))
}
