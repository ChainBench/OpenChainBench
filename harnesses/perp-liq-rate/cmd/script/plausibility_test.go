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
	base := rankInput{hasSource: true, fetchOK: true, oiSamples: minOISamples, meanOIUSD: 1, hasVolume: true}
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
		// near-empty bucket. Below the floor, so it cannot win the board.
		{"lighter ETH frozen at $887", with(887, 185.6e6), false, reasonBelowFloor},
		// dYdX v4: one LIQUIDATED fill in 24 hours, verified by paging the
		// tape. A correct reading, and not a rate.
		{"dydx ETH $466.93", with(466.93, 54.97e6), false, reasonBelowFloor},
		{"dydx BTC $16.92", with(16.92, 7.24e6), false, reasonBelowFloor},
		// dYdX SOL had real flow the same day and does rank.
		{"dydx SOL 0.092%", with(5024.62, 5.45e6), true, reasonRanked},
		// Paradex: a working feed with no LIQUIDATION row in 24h.
		{"paradex ETH exact zero", with(0, 1.41e6), false, reasonZero},
		// Gains: two positions at 136x and 78x, decode verified twice over.
		{"gains ETH 14.9%", with(18.75e6, 125.8e6), false, reasonAboveCeiling},
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
		meanOIUSD: 1e8, volUSD24h: 1e9, hasVolume: true}
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
		{"too few OI readings", func(in *rankInput) { in.oiSamples = minOISamples - 1 }, reasonWarmingUp},
		{"no open interest", func(in *rankInput) { in.meanOIUSD = 0 }, reasonNoOI},
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
	in := rankInput{hasSource: true, fetchOK: true, oiSamples: minOISamples, liqUSD24h: 5e6, meanOIUSD: 1e8}
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

// The denominator is a 24h mean, not an instant. Gains read 343% on
// 2026-09-24 because its open interest fell from $37M to $7.3M while the
// numerator stood still; on the mean the same numerator reads a fifth of it.
func TestSampleWindowMeanSteadiesTheDenominator(t *testing.T) {
	s := NewSampleWindow(24 * time.Hour)
	now := time.Now().UnixMilli()
	for i, oi := range []float64{37e6, 36e6, 31e6, 20e6, 7.3e6} {
		s.Add(now-int64(len(([]int{1, 2, 3, 4, 5}))-i)*3600*1000, oi)
	}
	mean := s.Mean()
	if mean < 26e6 || mean > 27e6 {
		t.Fatalf("mean = %.0f, want about 26.3M", mean)
	}

	liq := 25.17e6
	onInstant := liq / 7.3e6 * 100
	onMean := liq / mean * 100
	if onInstant < 340 || onInstant > 350 {
		t.Fatalf("instant rate = %.1f%%, want about 345%%", onInstant)
	}
	if onMean > 100 {
		t.Fatalf("mean-denominator rate = %.1f%%, still above 100%%", onMean)
	}

	s2 := NewSampleWindow(24 * time.Hour)
	if got := s2.Mean(); got != 0 {
		t.Fatalf("empty mean = %v, want 0", got)
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
	if got := s.Mean(); math.Abs(got-10) > 1e-9 {
		t.Fatalf("Mean = %v, want 10", got)
	}
}
