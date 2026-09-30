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

	liqForfeited = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_collateral_forfeited_pct",
		Help: "Median share of a liquidated position's margin destroyed in excess of the loss the trader had actually incurred, over the forced closes of the trailing 24h whose leverage is between 10x and 100x. Restricted to that range because the forfeit grows with leverage and the venues do not sell the same leverage: over one common 29-day window on crypto, Gains reads 40.1 points over all leverage and 36.7 inside the range, since 48.2% of its liquidations sit above 100x where GMX records none. Computed per close as 100 minus its own loss and payout, then the median of those, so it is NOT this gauge minus the medians beside it. It contains the venue's liquidation penalty AND the trading fees and carry the trader did incur; perp_liq_fee_and_carry_pct itemises the second part where the feed can. Per-band figures carry the whole curve.",
	}, []string{"venue", "chain"})

	liqLossAtTrigger = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_loss_at_trigger_pct",
		Help: "Median share of a liquidated position's margin the price had already taken when the venue closed it, over the forced closes of the trailing 24h between 10x and 100x. The price move times the leverage, before fees and carry, which is how all three venues that report it define their own figure. A LOWER figure means the venue closed earlier relative to the margin and kept more of it: at 10x to 25x Gains reads 70.8%, GMX 85.1% and Ostium 95.1%. Clamped to 100, since a venue that closes later than the margin lasted absorbs the difference.",
	}, []string{"venue", "chain"})

	liqReturned = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_collateral_returned_pct",
		Help: "Median share of a liquidated position's margin that went back to the trader, over the forced closes of the trailing 24h between 10x and 100x. Zero is a real reading and the common one: Gains and Ostium returned nothing on any of the 21,105 and 383 liquidations of a 29-day window, while GMX v2 pays out the residual after its fees and returned a median 17.5% inside the same range. Where a venue returns nothing the forfeit beside this is exactly 100 minus the loss, so the two carry one number between them.",
	}, []string{"venue", "chain"})

	liqForfeitEvents = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_forfeit_events",
		Help: "How many liquidations in the trailing 24h carried the position AND sat between 10x and 100x, which is the set the venue-level medians beside it are taken over. A row reading 1 or 2 is those positions and not a rate. A row reading 0 is a venue that can report and saw no qualifying close; a venue that cannot report publishes no series here at all. perp_liq_liquidations_by_leverage_count counts the unrestricted curve.",
	}, []string{"venue", "chain"})

	liqForfeitedByBand = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_collateral_forfeited_by_leverage_pct",
		Help: "Median forfeited share of margin per leverage band (0-5x, 5-10x, 10-25x, 25-50x, 50-100x, 100-200x, 200x+), bands being (min, max]. This is the only honest cross-venue comparison here, because the forfeit grows with leverage and the venues sell different ranges. A band a venue does not trade has no series, never a zero. Read with perp_liq_liquidations_by_leverage_count: a band holding two positions is those two positions.",
	}, []string{"venue", "chain", "band"})

	liqEventsByBand = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_liquidations_by_leverage_count",
		Help: "How many liquidations of the trailing 24h sit in each leverage band and carry the forfeit detail, over the whole curve rather than the comparable range. The denominator of the per-band gauges, published beside them so a band holding two positions cannot read as a measurement, and so a reader can see which bands each venue actually sells.",
	}, []string{"venue", "chain", "band"})

	liqFeeAndCarry = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_fee_and_carry_pct",
		Help: "Median share of a liquidated position's margin that went on trading fees and carry rather than on the venue's liquidation penalty, over the same closes as perp_liq_collateral_forfeited_pct. A fee is a cost the trader incurred and a penalty is not, so the forfeit above must not be read as a penalty on its own. Published only where the feed itemises it: GMX v2 does in full (positionFeeAmount, borrowingFeeAmount, fundingFeeAmount beside liquidationFeeAmount) and Ostium in part; the Gains event carries no fee word at all, so its row is absent rather than zero.",
	}, []string{"venue", "chain"})

	liqLossByBand = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_loss_at_trigger_by_leverage_pct",
		Help: "Median loss at trigger per leverage band, beside the forfeited share for the same band. The pair is the mechanism: a venue that closes at a lower loss keeps more of the margin, and band for band Gains closes earliest of the three. Volatility does not explain the gap, since gapping past the threshold would raise this figure and Gains' is the lowest and least dispersed.",
	}, []string{"venue", "chain", "band"})

	liqMarginDestroyedShare = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_margin_destroyed_share_pct",
		Help: "Margin destroyed by force over the trailing 24h as a percentage of the margin behind every position the venue closed in the same window. The leverage-neutral companion to perp_liq_share_of_volume_pct, which is notional over notional and so counts a 100x position at a hundred times the money behind it. Both halves are money the trader posted, so leverage cancels. Measured 2026-09-29: GMX v2 1.09% over 7 days, Ostium 1.38% over 30 days. Published only where the feed carries the position on both halves.",
	}, []string{"venue", "chain"})

	liqOpenInterest = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_usd",
		Help: "Current open interest (USD) per venue and asset, read fresh on every tick.",
	}, []string{"venue", "chain"})

	liqOpenInterestPeak = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_peak_24h_usd",
		Help: "Peak open interest (USD) over the trailing 24h, and the denominator of perp_liq_rate_24h_pct. Read from the venue's own on-chain record of every change where there is one (Gains), otherwise one sample per tick. An instantaneous denominator made the rate move with open interest (Gains read 343% on 2026-09-24), and the mean over the window still read 251% when Gains ETH fell from 43.7M to 2.1M dollars on 2026-09-28 because most of the book was liquidated; the peak is the largest book observed. One side for an order book, long plus short for a pool venue. Above 100% is turnover inside the window.",
	}, []string{"venue", "chain"})

	liqOpenInterestTrough = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_trough_24h_usd",
		Help: "Smallest open interest (USD) seen over the trailing 24h, published beside the peak because the gap between them says whether the peak and the mean describe the same market. Gains BTC ran from 49.94M dollars to 1.12M and back to 10.65M inside 2026-09-28.",
	}, []string{"venue", "chain"})

	liqOpenInterestAvg = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "perp_liq_open_interest_avg_24h_usd",
		Help: "Mean open interest (USD) over the trailing 24h, weighted by how long each reading stood rather than averaged over readings. Weighted rather than averaged over readings because the readings come from the venue's own events where it publishes them, and their density is uneven: Gains ETH had 67 in a whole day and 88 in the hour it collapsed.",
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
		liqForfeited,
		liqLossAtTrigger,
		liqReturned,
		liqForfeitEvents,
		liqFeeAndCarry,
		liqLossByBand,
		liqMarginDestroyedShare,
		liqForfeitedByBand,
		liqEventsByBand,
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

// setForfeitShares publishes the forfeited-collateral shares for a row, and
// withholds them rather than zeroing them when there is nothing to measure.
// Eight of the eleven venues here cannot report these quantities, and a 0.0% on
// such a row would read as a venue that forfeits none of its traders' margin.
//
// carriesDetail separates the two kinds of blank. A venue whose feed carries the
// position and simply saw no forced close in the window keeps
// perp_liq_forfeit_events at zero and loses its three medians, because there is
// nothing to take a median of; a venue whose feed cannot carry the position
// publishes no series at all, the count included.
func setForfeitShares(venue, asset string, s forfeitSummary, carriesDetail bool) {
	if s.N <= 0 {
		liqForfeited.DeleteLabelValues(venue, asset)
		liqLossAtTrigger.DeleteLabelValues(venue, asset)
		liqReturned.DeleteLabelValues(venue, asset)
		liqFeeAndCarry.DeleteLabelValues(venue, asset)
		if carriesDetail {
			liqForfeitEvents.WithLabelValues(venue, asset).Set(0)
		} else {
			liqForfeitEvents.DeleteLabelValues(venue, asset)
		}
		return
	}
	liqForfeited.WithLabelValues(venue, asset).Set(s.Forfeited)
	liqLossAtTrigger.WithLabelValues(venue, asset).Set(s.Loss)
	liqReturned.WithLabelValues(venue, asset).Set(s.Returned)
	liqForfeitEvents.WithLabelValues(venue, asset).Set(float64(s.N))
	// Only where the feed itemises the fees. On Gains it does not, and a zero
	// would say the whole forfeit is the venue's penalty, which is a claim the
	// event cannot support.
	if s.HasFeeSplit {
		liqFeeAndCarry.WithLabelValues(venue, asset).Set(s.FeeAndCarry)
	} else {
		liqFeeAndCarry.DeleteLabelValues(venue, asset)
	}
}

// setForfeitBands publishes the per-band medians and counts, deleting the bands
// the window no longer holds anything for so a band that has emptied does not
// keep yesterday's figure while the count beside it says nothing is there.
func setForfeitBands(venue, asset string, bands map[string]bandStats) {
	for _, b := range leverageBands {
		v, ok := bands[b.name]
		if !ok || v.N <= 0 {
			// A band the venue does not sell, or sold nothing into, has no
			// cell. Never a zero: a zero in the 200x+ column would say GMX
			// forfeits nothing there, when GMX does not trade there at all.
			liqForfeitedByBand.DeleteLabelValues(venue, asset, b.name)
			liqLossByBand.DeleteLabelValues(venue, asset, b.name)
			liqEventsByBand.DeleteLabelValues(venue, asset, b.name)
			continue
		}
		liqForfeitedByBand.WithLabelValues(venue, asset, b.name).Set(v.Forfeited)
		liqLossByBand.WithLabelValues(venue, asset, b.name).Set(v.Loss)
		liqEventsByBand.WithLabelValues(venue, asset, b.name).Set(float64(v.N))
	}
}
