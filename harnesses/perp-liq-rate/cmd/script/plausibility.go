package main

// plausibility.go — the test a row has to pass before this bench ranks it.
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
	// before a rate is ranked. Every liquidation source here backfills the
	// full 24h on its first tick, so the numerator is complete from the
	// start; the denominator is not, and a mean over one reading is the
	// instantaneous value whose swings this bench set out to stop
	// publishing. Twelve readings is an hour at the 5-minute cadence: long
	// enough that one outlying tick cannot carry the rate, short enough
	// that a redeploy does not blank the board for a day.
	minOISamples = 12
)

// rankReason names why a row is or is not ranked. The set is closed so it
// can be logged and asserted on without growing label cardinality.
type rankReason string

const (
	reasonRanked       rankReason = "ranked"
	reasonNoSource     rankReason = "no_liquidation_source"
	reasonFetchError   rankReason = "fetch_error"
	reasonWarmingUp    rankReason = "warming_up"
	reasonNoOI         rankReason = "no_open_interest"
	reasonNoVolume     rankReason = "no_volume_denominator"
	reasonZero         rankReason = "no_liquidations_observed"
	reasonBelowFloor   rankReason = "share_of_volume_below_floor"
	reasonAboveCeiling rankReason = "share_of_volume_above_ceiling"
)

// rankInput is everything the gate looks at for one venue and asset.
type rankInput struct {
	hasSource bool
	fetchOK   bool
	oiSamples int // readings behind meanOIUSD
	liqUSD24h float64
	meanOIUSD float64
	volUSD24h float64 // 0 when the venue publishes no 24h notional
	hasVolume bool
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
	case in.meanOIUSD <= 0:
		return false, reasonNoOI
	case in.oiSamples < minOISamples:
		return false, reasonWarmingUp
	case in.liqUSD24h <= 0:
		// A zero is unfalsifiable as a best value: it reads identically
		// whether the venue liquidated nothing or the feed returned
		// nothing. It publishes, it does not win.
		return false, reasonZero
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
