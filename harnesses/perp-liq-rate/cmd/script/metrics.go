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
		Help: "Current open interest (USD) per venue and asset, read fresh on every tick.",
	}, []string{"venue", "chain"})

	liqOpenInterestAvg = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_avg_24h_usd",
		Help: "Mean open interest (USD) over the trailing 24h, one sample per tick. This is the denominator of perp_liq_rate_24h_pct: the numerator covers 24 hours, so the denominator does too. Dividing a 24h sum by an instantaneous reading made the rate move with the denominator, which is how Gains published 343% on 2026-09-24 while its numerator stood still.",
	}, []string{"venue", "chain"})

	liqVenueVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_venue_volume_24h_usd",
		Help: "The venue's own 24h traded notional (USD) for this market, from the same endpoint that reports its open interest. Published only for venues that expose one.",
	}, []string{"venue", "chain"})

	liqShareOfVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_share_of_volume_pct",
		Help: "Liquidated notional over the trailing 24h as a percentage of the venue's own 24h traded notional. The plausibility test this bench ranks on: inside [0.01, 3] the figure is a measurement, below it an absence, above it a figure that is not comparable to the rest of the field.",
	}, []string{"venue", "chain"})

	liqLargestShare = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_largest_event_share_pct",
		Help: "The largest single liquidation in the 24h window as a percentage of the window total. Near 100 means the figure is one position rather than a flow.",
	}, []string{"venue", "chain"})

	liqRanked = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_ranked",
		Help: "1 when the row's liquidation rate is comparable to the rest of the field and takes a rank, 0 when it is published but not ranked. Read perp_liq_share_of_volume_pct, perp_liq_largest_event_share_pct and perp_liq_source_available for which condition failed; the harness logs the reason by name on every tick.",
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

	liqSourceAvailable = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_source_available",
		Help: "1 if a liquidation data source exists for the venue, 0 if liq_rate is structurally unavailable (not a data gap — use to display N/A instead of 0%).",
	}, []string{"venue"})

	realizedVol = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_realized_vol_24h_pct",
		Help: "24h realized volatility (%) computed from hourly HL close prices: sqrt(sum of squared log-returns). Asset-level, not venue-specific. Use as denominator companion to liq_rate.",
	}, []string{"chain"})
)

// registerMetrics builds a dedicated registry containing only this
// exporter's collectors.
func registerMetrics() *prometheus.Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		liqRate,
		liqVolume,
		liqOpenInterest,
		liqOpenInterestAvg,
		liqVenueVolume,
		liqShareOfVolume,
		liqLargestShare,
		liqRanked,
		liqWarmingUp,
		liqHealth,
		liqLastRefresh,
		liqFetchErrors,
		liqSourceAvailable,
		realizedVol,
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

// setRanked publishes whether the row takes a rank on the board.
func setRanked(venue, asset string, ranked bool) {
	v := 0.0
	if ranked {
		v = 1.0
	}
	liqRanked.WithLabelValues(venue, asset).Set(v)
}

// recordFetchError increments the error counter with a classified type.
func recordFetchError(venue, asset, errType string) {
	liqFetchErrors.WithLabelValues(venue, asset, errType).Inc()
}

// setSourceAvailable publishes whether a liquidation source exists for the venue.
func setSourceAvailable(venue string, available bool) {
	v := 0.0
	if available {
		v = 1.0
	}
	liqSourceAvailable.WithLabelValues(venue).Set(v)
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
