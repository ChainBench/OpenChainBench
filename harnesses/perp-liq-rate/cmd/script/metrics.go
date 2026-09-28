package main

// metrics.go: all Prometheus collectors plus small update helpers so the
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
		Help: "Liquidated notional over the trailing 24h as a percentage of the peak open interest over the same 24h (perp_liq_volume_24h_usd / perp_liq_open_interest_peak_24h_usd * 100): the share of the largest book the venue held that day that was closed by force. Published once the denominator holds twelve readings.",
	}, []string{"venue", "chain"})

	liqVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_volume_24h_usd",
		Help: "Sum of liquidated notional (USD) over the trailing 24h sliding window.",
	}, []string{"venue", "chain"})

	liqCollateral = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_collateral_24h_usd",
		Help: "Collateral (USD) behind the positions liquidated over the trailing 24h: the margin traders actually lost, as opposed to the notional closed. Published only where the source exposes the position behind the fill (Gains, from the Trade tuple on chain); a trade tape carries size and price and cannot say. On 2026-09-28 Gains liquidated 39.5M dollars of notional on 423k of collateral.",
	}, []string{"venue", "chain"})

	liqMedianLeverage = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_median_leverage_x",
		Help: "Median leverage of the positions liquidated over the trailing 24h, as a multiple, where the source exposes it. The number that says why two venues with similar notional rates are not comparable: a rate over notional counts a 100x position at 100 times the money behind it.",
	}, []string{"venue", "chain"})

	liqOpenInterest = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_usd",
		Help: "Current open interest (USD) per venue and asset, read fresh on every tick.",
	}, []string{"venue", "chain"})

	liqOpenInterestPeak = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_peak_24h_usd",
		Help: "Peak open interest (USD) over the trailing 24h, one sample per tick. This is the denominator of perp_liq_rate_24h_pct. An instantaneous denominator made the rate move with open interest (Gains read 343% on 2026-09-24), and the mean over the window still read 251% when Gains ETH fell from 43.7M to 2.1M dollars on 2026-09-28 because most of the book was liquidated; the peak is the largest book observed. One side for an order book, long plus short for a pool venue. Above 100% is turnover inside the window.",
	}, []string{"venue", "chain"})

	liqOpenInterestTrough = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_trough_24h_usd",
		Help: "Smallest open interest (USD) seen over the trailing 24h, published beside the peak because the gap between them says whether the peak and the mean describe the same market. Gains BTC ran from 49.94M dollars to 1.12M and back to 10.65M inside 2026-09-28.",
	}, []string{"venue", "chain"})

	liqOpenInterestAvg = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_avg_24h_usd",
		Help: "Mean open interest (USD) over the trailing 24h, weighted by how long each reading stood. Weighted rather than averaged over readings because the readings come from the venue's own events where it publishes them, and their density is uneven: Gains ETH had 67 in a whole day and 88 in the hour it collapsed.",
	}, []string{"venue", "chain"})

	liqVenueVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_venue_volume_24h_usd",
		Help: "The venue's own 24h traded notional (USD) for this market, from the same endpoint that reports its open interest. Published only for venues that expose one.",
	}, []string{"venue", "chain"})

	liqShareOfVolume = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_share_of_volume_pct",
		Help: "Liquidated notional over the trailing 24h as a percentage of the venue's own 24h traded notional. Part of the test this bench ranks on: inside [0.01, 3] the figure is a measurement, below it an absence, above it a figure that is not comparable to the rest of the field.",
	}, []string{"venue", "chain"})

	liqLargestShare = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_largest_event_share_pct",
		Help: "The largest single liquidation in the 24h window as a percentage of the window total. Above 50 the row does not rank: the figure is one position rather than a flow. Absent for rows read from hourly buckets or a cumulative counter, which carry no single event.",
	}, []string{"venue", "chain"})

	liqNewestAge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_newest_event_age_seconds",
		Help: "Seconds since the most recent liquidation the feed reported for this row. A large age against a busy book is a feed that has stopped, not a quiet venue: 0xArchive's ETH feed sat nine hours stale on 2026-09-27 while BTC and SOL were current.",
	}, []string{"venue", "chain"})

	liqRanked = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_ranked",
		Help: "1 when the row's liquidation rate is comparable to the rest of the field and takes a rank, 0 when it is published but not ranked. Read perp_liq_share_of_volume_pct, perp_liq_largest_event_share_pct and perp_liq_source_available for which condition failed; the harness logs the reason by name on every tick.",
	}, []string{"venue", "chain"})

	liqWarmingUp = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_warming_up",
		Help: "1 while any of the venue's rows holds fewer than twelve open-interest readings, during which its rate and peak are not published; 0 once they are. The numerator is backfilled in full on the first tick, so this is only the denominator filling.",
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
		Help: "1 if a liquidation data source exists for the venue, 0 if liq_rate is structurally unavailable (not a data gap: use to display N/A instead of 0%).",
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
		liqCollateral,
		liqMedianLeverage,
		liqOpenInterest,
		liqOpenInterestPeak,
		liqOpenInterestTrough,
		liqOpenInterestAvg,
		liqVenueVolume,
		liqShareOfVolume,
		liqLargestShare,
		liqNewestAge,
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
