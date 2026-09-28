package main

import (
	"math"
	"testing"
	"time"
)

// The fixtures are the figures measured on 2026-09-27 against each venue's
// own 24h traded notional, so the gate is tested on the field it was built
// for rather than on invented numbers.
func TestEvaluateRank_MeasuredField(t *testing.T) {
	base := rankInput{hasSource: true, fetchOK: true, oiSamples: minOISamples, peakOIUSD: 1, hasVolume: true, oiSpansWindow: true}
	with := func(liq, vol float64) rankInput {
		in := base
		in.liqUSD24h, in.volUSD24h = liq, vol
		return in
	}

	cases := []struct {
		name       string
		in         rankInput
		wantRanked bool
		wantReason rankReason
	}{
		// Hyperliquid, 0xArchive, all liquidation types.
		{"hyperliquid ETH 0.40%", with(2.0e6, 498.3e6), true, reasonRanked},
		{"hyperliquid BTC 0.17%", with(1.87e6, 1128.9e6), true, reasonRanked},
		// Lighter via Coinalyze hourly buckets, after the restatement fix.
		{"lighter ETH 0.024%", with(44.0e3, 185.6e6), true, reasonRanked},
		{"lighter BTC 0.022%", with(67.7e3, 312.3e6), true, reasonRanked},
		// Lighter as it actually published before the fix: one frozen,
		// near-empty bucket. A few hundred dollars is not a day's flow.
		{"lighter ETH frozen at $887", with(887, 185.6e6), false, reasonTooSmall},
		// dYdX v4: one LIQUIDATED fill in 24 hours, verified by paging the
		// tape. A correct reading, and not a rate.
		{"dydx ETH $466.93", with(466.93, 54.97e6), false, reasonTooSmall},
		{"dydx BTC $16.92", with(16.92, 7.24e6), false, reasonTooSmall},
		// dYdX SOL had ten fills the same day, 5,024 dollars in all: real,
		// and still under the notional floor.
		{"dydx SOL 0.092%", with(5024.62, 5.45e6), false, reasonTooSmall},
		// Paradex: a working feed with no LIQUIDATION row in 24h.
		{"paradex ETH exact zero", with(0, 1.41e6), false, reasonZero},
		// Gains: two positions at 136x and 78x, decode verified twice over.
		{"gains ETH 14.9%", with(18.75e6, 125.8e6), false, reasonAboveCeiling},
		// A day whose share of volume sits well inside the band but whose
		// figure is one liquidation: Hyperliquid ETH's short feed on
		// 2026-09-27 read 64% on its largest event, GMX ETH 92%.
		{"gmx ETH one event is 92%", func() rankInput {
			in := with(276.8e3, 3.65e6)
			in.hasEventDetail, in.largestEventPct = true, 92
			return in
		}(), false, reasonSingleEvent},
		{"hyperliquid BTC largest event 9%", func() rankInput {
			in := with(1.87e6, 1128.9e6)
			in.hasEventDetail, in.largestEventPct = true, 9
			return in
		}(), true, reasonRanked},
		// Ostium BTC on 2026-09-28: 338 dollars from one event, 0.458% of a
		// 73,665 dollar day. Inside the band, refused on size.
		{"ostium BTC $338 one event", func() rankInput {
			in := with(338, 73.665e3)
			in.hasEventDetail, in.largestEventPct = true, 100
			return in
		}(), false, reasonTooSmall},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ranked, reason := evaluateRank(c.in)
			if ranked != c.wantRanked || reason != c.wantReason {
				t.Fatalf("got (%v, %s), want (%v, %s) at share %.5f%%",
					ranked, reason, c.wantRanked, c.wantReason, c.in.shareOfVolumePct())
			}
		})
	}
}

func TestEvaluateRank_StructuralRefusals(t *testing.T) {
	good := rankInput{hasSource: true, fetchOK: true, oiSamples: minOISamples, liqUSD24h: 1e6,
		peakOIUSD: 1e8, volUSD24h: 1e9, hasVolume: true, oiSpansWindow: true}
	if ranked, reason := evaluateRank(good); !ranked || reason != reasonRanked {
		t.Fatalf("baseline should rank, got (%v, %s)", ranked, reason)
	}

	cases := []struct {
		name   string
		mutate func(*rankInput)
		want   rankReason
	}{
		{"no source", func(in *rankInput) { in.hasSource = false }, reasonNoSource},
		{"fetch failed", func(in *rankInput) { in.fetchOK = false }, reasonFetchError},
		{"window read short", func(in *rankInput) { in.partialWindow = true }, reasonPartial},
		{"too few OI readings", func(in *rankInput) { in.oiSamples = minOISamples - 1 }, reasonWarmingUp},
		{"oi window shorter than the numerator", func(in *rankInput) { in.oiSpansWindow = false }, reasonOIShort},
		{"no open interest", func(in *rankInput) { in.peakOIUSD = 0 }, reasonNoOI},
		{"no volume endpoint", func(in *rankInput) { in.hasVolume = false }, reasonNoVolume},
		{"volume endpoint read zero", func(in *rankInput) { in.volUSD24h = 0 }, reasonNoVolume},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := good
			c.mutate(&in)
			ranked, reason := evaluateRank(in)
			if ranked || reason != c.want {
				t.Fatalf("got (%v, %s), want (false, %s)", ranked, reason, c.want)
			}
		})
	}
}

// A venue with no volume denominator is refused before the band is consulted,
// so a missing denominator can never be read as a passing share of zero.
func TestEvaluateRank_ShareIsZeroWithoutDenominator(t *testing.T) {
	in := rankInput{hasSource: true, fetchOK: true, oiSamples: minOISamples, liqUSD24h: 5e6, peakOIUSD: 1e8, oiSpansWindow: true}
	if got := in.shareOfVolumePct(); got != 0 {
		t.Fatalf("share = %v, want 0 with no denominator", got)
	}
	if ranked, reason := evaluateRank(in); ranked || reason != reasonNoVolume {
		t.Fatalf("got (%v, %s), want (false, %s)", ranked, reason, reasonNoVolume)
	}
}

// The restatement path: an hourly bucket read again with a larger figure
// replaces the one held, and does not add to it.
func TestSlidingWindowUpsertRestatesBuckets(t *testing.T) {
	w := NewSlidingWindow(24 * time.Hour)
	now := time.Now().UnixMilli()

	if !w.Upsert("hour:1", now, 100) {
		t.Fatal("first Upsert should report a change")
	}
	if !w.Upsert("hour:1", now, 4400) {
		t.Fatal("a larger reading for the same hour should report a change")
	}
	if w.Upsert("hour:1", now, 4400) {
		t.Fatal("an unchanged reading should report no change")
	}
	if got := w.Sum(); got != 4400 {
		t.Fatalf("Sum = %v, want 4400 (restated, not accumulated)", got)
	}
	if got := w.Len(); got != 1 {
		t.Fatalf("Len = %d, want 1", got)
	}

	w.Upsert("hour:2", now, 600)
	if got := w.Sum(); got != 5000 {
		t.Fatalf("Sum = %v, want 5000", got)
	}
	if got := w.Max(); got != 4400 {
		t.Fatalf("Max = %v, want 4400", got)
	}
}

// Prune compacts the entry slice, so the key index has to survive it or the
// next restatement appends a second copy of an hour already held.
func TestSlidingWindowUpsertAfterPrune(t *testing.T) {
	w := NewSlidingWindow(24 * time.Hour)
	now := time.Now().UnixMilli()
	w.Upsert("stale", now-25*3600*1000, 999)
	w.Upsert("live", now-3600*1000, 100)
	w.Prune(now)

	if got := w.Sum(); got != 100 {
		t.Fatalf("Sum after prune = %v, want 100", got)
	}
	w.Upsert("live", now-3600*1000, 250)
	if got := w.Sum(); got != 250 {
		t.Fatalf("Sum = %v, want 250; the key index did not survive Prune", got)
	}
	if got := w.Len(); got != 1 {
		t.Fatalf("Len = %d, want 1; Prune left a stale index entry", got)
	}
}

// The denominator is the window's peak open interest, not an instant and
// not the mean. Gains read 343% on 2026-09-24 against the instant ($37M to
// $7.3M while the numerator stood still), and on 2026-09-28 its ETH book
// went from $43.7M to $2.1M because most of it was liquidated: $27.3M of
// liquidations read 251% against the mean of $10.9M and 62% against the
// peak, which is the most that could have been liquidated from the book.
func TestSampleWindowPeakIsTheDenominator(t *testing.T) {
	s := NewSampleWindow(24 * time.Hour)
	now := time.Now().UnixMilli()
	readings := []float64{43.67e6, 40e6, 30e6, 12e6, 5e6, 2.09e6}
	for i, oi := range readings {
		s.Add(now-int64(len(readings)-i)*3600*1000, oi)
	}
	peak, mean := s.Max(), s.TimeWeightedMean(now)
	if peak != 43.67e6 {
		t.Fatalf("peak = %.0f, want 43.67M", peak)
	}

	liq := 27.29e6
	onInstant := liq / 2.09e6 * 100
	onMean := liq / mean * 100
	onPeak := liq / peak * 100
	if onInstant < 1000 {
		t.Fatalf("instant rate = %.1f%%, want above 1000%%", onInstant)
	}
	if onMean < 100 {
		t.Fatalf("mean-denominator rate = %.1f%%, expected the 2026-09-28 artifact above 100%%", onMean)
	}
	if onPeak < 62 || onPeak > 63 {
		t.Fatalf("peak-denominator rate = %.1f%%, want about 62.5%%", onPeak)
	}

	s2 := NewSampleWindow(24 * time.Hour)
	if got := s2.Max(); got != 0 {
		t.Fatalf("empty peak = %v, want 0", got)
	}
}

// Readings older than the span fall out, so a restart does not carry a stale
// denominator forward.
func TestSampleWindowPrunesOnAdd(t *testing.T) {
	s := NewSampleWindow(2 * time.Hour)
	now := time.Now().UnixMilli()
	s.Add(now-5*3600*1000, 1000)
	s.Add(now, 10)
	if s.Len() != 1 {
		t.Fatalf("Len = %d, want 1", s.Len())
	}
	if got := s.TimeWeightedMean(now); math.Abs(got-10) > 1e-9 {
		t.Fatalf("TimeWeightedMean = %v, want 10", got)
	}
}

// An unranked row still renders its headline figure, so a refusal that means
// the ratio describes nothing has to withhold the ratio and not merely set
// perp_liq_ranked to 0. Gains ETH published 952% while unranked for
// single_event_is_the_window, against a peak open interest that covered the
// quiet hour after the cascade rather than the book the cascade liquidated.
func TestRateIsMeaningful(t *testing.T) {
	withheld := []rankReason{
		reasonSingleEvent, reasonNoVolume, reasonOIShort,
		reasonWarmingUp, reasonNoOI, reasonFetchError, reasonPartial,
	}
	for _, r := range withheld {
		if rateIsMeaningful(r) {
			t.Errorf("%s publishes a rate it cannot defend", r)
		}
	}
	// These divide a real 24h numerator by a real 24h book. The board may
	// refuse to order them, and the figure is still a figure.
	kept := []rankReason{
		reasonRanked, reasonZero, reasonTooSmall,
		reasonBelowFloor, reasonAboveCeiling, reasonNoSource,
	}
	for _, r := range kept {
		if r == reasonNoSource {
			continue // no source publishes no rate at all, upstream of this
		}
		if !rateIsMeaningful(r) {
			t.Errorf("%s withholds a rate that is sound", r)
		}
	}
}
