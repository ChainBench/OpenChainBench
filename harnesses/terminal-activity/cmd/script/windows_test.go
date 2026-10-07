package main

import (
	"math"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func mkDetail(bot string, days []string, chain string, vol, txn, fee []float64) *botDetail {
	return &botDetail{Bot: bot, Days: days, Series: []chainSeries{{
		Name: chain, VolumeUSD: vol, Txns: txn, FeesUSD: fee,
	}}}
}

// Windows are sums over days, and the all-chains slice sums over chains too.
func TestWindowsSumDaysAndChains(t *testing.T) {
	d := &botDetail{Bot: "axiom", FirstDay: "2026-10-04", Through: "2026-10-06",
		Days: []string{"d1", "d2", "d3"}, Series: []chainSeries{
			{Name: "solana", VolumeUSD: []float64{100, 200, 300}, Txns: []float64{1, 2, 3}, FeesUSD: []float64{1, 2, 3}},
			{Name: "bnb", VolumeUSD: []float64{10, 20, 30}, Txns: []float64{1, 1, 1}, FeesUSD: []float64{1, 1, 1}},
		}}
	agg, first, _ := buildWindows([]*botDetail{d})

	if got := agg["axiom|solana|1d"].vol; got != 300 {
		t.Errorf("1d takes the latest day only: got %v want 300", got)
	}
	if got := agg["axiom|solana|7d"].vol; got != 600 {
		t.Errorf("7d sums the three available days: got %v want 600", got)
	}
	if got := agg["axiom|all|7d"].vol; got != 660 {
		t.Errorf("all-chains sums both chains: got %v want 660", got)
	}
	// Age, not window size: first_day to through, inclusive. len(Days) would
	// read 30 for every platform because that is the window this harness asks
	// for, and the column would mean nothing.
	if got := first["axiom"]; got != 3 {
		t.Errorf("history is first_day to through: got %v want 3", got)
	}
}

// The window take rate divides by the volume of the days it could measure.
//
// Same rule as the daily guard, applied over time. A platform that charges
// somewhere has its zero days excluded from the ratio entirely; dividing the
// fees it did report by all of its volume reads a terminal as cheaper the less
// of it could be measured.
func TestWindowTakeRateExcludesUnmeasuredDays(t *testing.T) {
	// Charges on day 2 only; day 1 and 3 are gaps, not free days.
	d := mkDetail("axiom", []string{"d1", "d2", "d3"}, "solana",
		[]float64{1000, 1000, 1000}, []float64{10, 10, 10}, []float64{0, 9.2, 0})
	agg, _, _ := buildWindows([]*botDetail{d})
	a := agg["axiom|solana|7d"]
	if a.vol != 3000 {
		t.Fatalf("precondition: volume totals all three days, got %v", a.vol)
	}
	got := a.fees / a.feeVol * 100
	if math.Abs(got-0.92) > 1e-9 {
		t.Errorf("take rate must be 9.2/1000 = 0.92%%, got %v (0.31 means the gap days stayed in)", got)
	}
}

// A platform that reports no fees anywhere in the window is uniformly free and
// keeps a real zero, so the guard above does not erase it.
func TestUniformlyFreePlatformKeepsItsZero(t *testing.T) {
	d := mkDetail("freebot", []string{"d1", "d2"}, "solana",
		[]float64{500, 500}, []float64{5, 5}, []float64{0, 0})
	agg, _, _ := buildWindows([]*botDetail{d})
	a := agg["freebot|solana|7d"]
	if !a.feeOK {
		t.Fatal("a uniformly free platform must still have a usable fee window")
	}
	if a.fees != 0 || a.feeVol != 1000 {
		t.Errorf("expected 0 fees over 1000 volume, got %v over %v", a.fees, a.feeVol)
	}
}

// Share is this platform's slice of the cohort on that chain and window, and
// the denominator has to be whole before any share is written.
func TestShareIsOfTheCohortTotal(t *testing.T) {
	for _, g := range windowGauges() {
		g.Reset()
	}
	historyDays.Reset()
	a := mkDetail("axiom", []string{"d1"}, "solana", []float64{750}, []float64{1}, []float64{1})
	b := mkDetail("gmgn", []string{"d1"}, "solana", []float64{250}, []float64{1}, []float64{1})
	agg, first, chains := buildWindows([]*botDetail{a, b})
	publishWindows(agg, []string{"axiom", "gmgn"}, chains, first)

	if got := testutil.ToFloat64(windowSharePct.WithLabelValues("axiom", "solana", "1d")); math.Abs(got-75) > 1e-9 {
		t.Errorf("axiom share: got %v want 75", got)
	}
	if got := testutil.ToFloat64(windowSharePct.WithLabelValues("gmgn", "solana", "1d")); math.Abs(got-25) > 1e-9 {
		t.Errorf("gmgn share: got %v want 25", got)
	}
}
