package main

// plausibility.go: the test a row has to pass before this bench ranks it.
//
// Why a gate exists at all. Every number this harness published on
// 2026-09-27 was a correct reading of its own source, and the board was
// still wrong, because the sources do not agree on what a liquidation is.
// Measured that day against each venue's own 24h traded notional:
//
//	Hyperliquid BTC  0.17%   SOL 0.93%   ETH 0.005% (0xArchive; the ETH
//	                                     feed returned 22 events against
//	                                     693 on BTC, a short feed)
//	Aster       ETH  0.18%   BTC 0.09%   (Coinalyze hourly buckets)
//	Lighter     ETH  0.024%  BTC 0.018%  (Coinalyze hourly buckets)
//	dYdX v4     ETH  0.00085% BTC 0.00023% (one LIQUIDATED fill in 24h)
//	Paradex     ETH  0%      BTC 0%      (no LIQUIDATION row in 24h)
//	Gains       ETH  14.9% of venue-level volume (two positions at 136x and
//	                                     78x leverage; no per-asset notional)
//
// Four orders of magnitude, every figure defensible on its own terms. A
// venue that liquidates a ten-thousandth of a percent of its volume is not
// careful, and one that liquidates a seventh of it is not reckless; both are
// reading something the other is not. So a row publishes its figures either
// way and ranks only when the figure sits in the band a perp venue's
// liquidation flow actually occupies.
//
// The band is stated as a share of the venue's own 24h traded notional,
// because that is a denominator nearly every venue publishes itself (GMX's
// comes from the same squid as its liquidations) and it cancels venue size.

const (
	// liqShareFloorPct: below this the figure is an absence, not a
	// measurement. dYdX v4 at 0.00085% and Paradex at exactly 0 are the
	// cases this excludes; both come off working feeds that reported one
	// fill and none respectively over a full 24 hours.
	liqShareFloorPct = 0.01

	// liqShareCeilPct: above this the figure is not comparable to the rest
	// of the field, whatever its provenance. Gains at 14.9% is the case
	// this excludes.
	liqShareCeilPct = 3.0

	// minOISamples: how many open-interest readings the denominator needs
	// before a rate is published or ranked. Every liquidation source here
	// backfills the full 24h on its first tick, so the numerator is complete
	// from the start; the denominator is not, and the peak of one reading
	// is the instantaneous value whose swings this bench set out to stop
	// publishing. Twelve readings is an hour at the 5-minute cadence: long
	// enough that one outlying tick cannot carry the rate, short enough
	// that a redeploy does not blank the board for a day.
	minOISamples = 12

	// liqLargestEventCeilPct: a row whose largest single liquidation is
	// more than half of its 24h figure is one position, not a flow, and a
	// rate over a flow is what this bench ranks. On 2026-09-28 Ostium BTC
	// ranked at 0.458% of its volume on 338 dollars from one event while
	// dYdX BTC sat unranked on 537 dollars from one event; the share of
	// volume cannot tell those apart, the event count can. Only rows with
	// per-event detail are tested; hourly buckets and cumulative counters
	// carry no single event.
	liqLargestEventCeilPct = 50.0

	// liqMinNotionalUSD: under this much liquidated in a day the figure is
	// a handful of positions whatever the venue's size, and a venue whose
	// whole day is a few hundred dollars is not in the same measurement as
	// one that liquidates millions. Ten thousand dollars is a fraction of
	// the smallest figure that ranked on a book of institutional size
	// (Lighter ETH, 44,303 dollars on 2026-09-27).
	liqMinNotionalUSD = 10_000.0
)

// rankReason names why a row is or is not ranked. The set is closed so it
// can be logged and asserted on without growing label cardinality.
type rankReason string

const (
	reasonRanked       rankReason = "ranked"
	reasonNoSource     rankReason = "no_liquidation_source"
	reasonFetchError   rankReason = "fetch_error"
	reasonPartial      rankReason = "window_read_short"
	reasonWarmingUp    rankReason = "warming_up"
	reasonOIShort      rankReason = "oi_window_shorter_than_numerator"
	reasonNoOI         rankReason = "no_open_interest"
	reasonNoVolume     rankReason = "no_volume_denominator"
	reasonZero         rankReason = "no_liquidations_observed"
	reasonTooSmall     rankReason = "liquidated_notional_below_floor"
	reasonSingleEvent  rankReason = "single_event_is_the_window"
	reasonBelowFloor   rankReason = "share_of_volume_below_floor"
	reasonAboveCeiling rankReason = "share_of_volume_above_ceiling"
)

// rankInput is everything the gate looks at for one venue and asset.
type rankInput struct {
	hasSource bool
	fetchOK   bool
	// partialWindow is set while the window is missing its oldest part
	// because a page cap cut a read short; the numerator is real and low.
	partialWindow bool
	// oiSpansWindow is false while the open-interest readings cover less
	// than the span the numerator covers, so their peak is the peak of a
	// shorter period. Dividing a full 24h of liquidations by it is how Gains
	// ETH published 952% an hour after a redeploy.
	oiSpansWindow bool
	oiSamples     int // readings behind peakOIUSD
	liqUSD24h     float64
	peakOIUSD     float64
	volUSD24h     float64 // 0 when the venue publishes no 24h notional
	hasVolume     bool
	// hasEventDetail is false for a source that reports hourly buckets or a
	// windowed total, where no single event exists to test.
	hasEventDetail  bool
	largestEventPct float64 // largest single liquidation as % of liqUSD24h
}

// shareOfVolumePct is the liquidated notional as a percentage of the venue's
// own 24h traded notional, or 0 when there is no denominator.
func (in rankInput) shareOfVolumePct() float64 {
	if !in.hasVolume || in.volUSD24h <= 0 {
		return 0
	}
	return in.liqUSD24h / in.volUSD24h * 100
}

// evaluateRank decides whether the row ranks, and says why. The order of the
// checks is the order a reader would ask them in, so the reason published is
// the first thing actually wrong rather than an arbitrary one.
func evaluateRank(in rankInput) (bool, rankReason) {
	switch {
	case !in.hasSource:
		return false, reasonNoSource
	case !in.fetchOK:
		return false, reasonFetchError
	case in.partialWindow:
		return false, reasonPartial
	case in.peakOIUSD <= 0:
		return false, reasonNoOI
	case in.oiSamples < minOISamples:
		return false, reasonWarmingUp
	case !in.oiSpansWindow:
		return false, reasonOIShort
	case in.liqUSD24h <= 0:
		// A zero is unfalsifiable as a best value: it reads identically
		// whether the venue liquidated nothing or the feed returned
		// nothing. It publishes, it does not win.
		return false, reasonZero
	case in.liqUSD24h < liqMinNotionalUSD:
		return false, reasonTooSmall
	case in.hasEventDetail && in.largestEventPct > liqLargestEventCeilPct:
		return false, reasonSingleEvent
	case !in.hasVolume || in.volUSD24h <= 0:
		return false, reasonNoVolume
	}
	share := in.shareOfVolumePct()
	switch {
	case share < liqShareFloorPct:
		return false, reasonBelowFloor
	case share > liqShareCeilPct:
		return false, reasonAboveCeiling
	}
	return true, reasonRanked
}

// rateIsMeaningful says whether perp_liq_rate_24h_pct may be published for a
// row the gate refused. An unranked row still renders its headline figure, so
// a refusal that means "this ratio does not describe anything" has to delete
// the series rather than merely set perp_liq_ranked to 0: Gains ETH published
// 952% against a denominator that no longer existed, and a reader who sees
// that will not go looking for the reason.
//
// The inputs are published either way. They are sound and useful on their
// own: liquidated notional, collateral, open interest, share of volume and
// the largest-event share are all measurements. It is only the ratio built on
// a denominator or a numerator that cannot carry it which is withheld.
func rateIsMeaningful(reason rankReason) bool {
	switch reason {
	case reasonSingleEvent:
		// One position is not a rate, whatever it divides by.
		return false
	case reasonNoVolume:
		// Nothing tested the figure, so the band never vouched for it.
		return false
	case reasonOIShort, reasonWarmingUp, reasonNoOI, reasonFetchError:
		// The denominator is not the 24h book, or is not there at all.
		return false
	case reasonPartial:
		// The numerator is missing its oldest part by a known amount.
		return false
	}
	// Ranked, an honest zero, a real flow below the notional floor, and a
	// share outside the band all divide a real 24h numerator by a real 24h
	// book. They publish, and the board orders them or does not.
	return true
}
