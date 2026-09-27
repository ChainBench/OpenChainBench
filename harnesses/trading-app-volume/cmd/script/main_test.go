package main

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// days builds an app's history ending on lastClosed with n days, each priced
// with the given revenue per day (a negative entry means "no revenue that day").
func days(lastClosed time.Time, usd float64, revs []float64) []DayPoint {
	out := make([]DayPoint, 0, len(revs))
	for i := len(revs) - 1; i >= 0; i-- {
		d := lastClosed.AddDate(0, 0, -i)
		p := DayPoint{Day: fmtDay(d), USD: usd}
		if revs[i] >= 0 {
			p.Rev, p.HasRev = revs[i], true
		}
		out = append(out, p)
	}
	return out
}

func historyFor(lastClosed time.Time, apps ...AppHistory) *History {
	return &History{LastClosedDay: fmtDay(lastClosed), Apps: apps}
}

// forget removes every gauge child for a slug, so one test's app cannot leak
// into another test's series count.
func forget(slug string) {
	for _, g := range []*prometheus.GaugeVec{gVolume, gRevenue, gTakeRate, gWindowDays, gShare} {
		g.DeletePartialMatch(prometheus.Labels{"app": slug})
	}
	for _, g := range []*prometheus.GaugeVec{gRevDay, gLastDay, gChains, gHealth, gDays} {
		g.DeleteLabelValues(slug)
	}
	gChain.DeletePartialMatch(prometheus.Labels{"app": slug})
}

// A day DeFiLlama returns as zero revenue against real volume is an artifact.
// It must be kept out of the 1d anchor, and out of the 7d and 30d windows too:
// the first fix left it diluting the windows, so the 7d take rate read lower
// than any day inside it.
func TestZeroRevenueDayIsLeftOutOfEveryWindow(t *testing.T) {
	last := utcDay(time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC))
	// revs[0] is the newest day. 1% every day, except the newest which reads 0.
	revs := make([]float64, 30)
	for i := range revs {
		revs[i] = 1000
	}
	revs[0] = 0
	app := AppHistory{App: App{Slug: "zeroday", Fees: true}, LastDay: fmtDay(last), Days: days(last, 100000, revs)}
	t.Cleanup(func() { forget("zeroday") })

	publish(historyFor(last, app))

	for _, w := range []string{"1d", "7d", "30d"} {
		got := testutil.ToFloat64(gTakeRate.WithLabelValues("zeroday", w))
		if got < 0.99 || got > 1.01 {
			t.Errorf("%s take rate = %.3f%%, want 1%% (the zero day must not dilute it)", w, got)
		}
	}
	// The anchor moved back one day to the newest positive one.
	want := float64(last.AddDate(0, 0, -1).Unix())
	if got := testutil.ToFloat64(gRevDay.WithLabelValues("zeroday")); got != want {
		t.Errorf("revenue day = %v, want %v", got, want)
	}
}

// An app whose cut genuinely is zero has no positive day anywhere, so its zeros
// are its figures and it publishes a real 0% rather than nothing.
func TestGenuinelyZeroCutStillPublishes(t *testing.T) {
	last := utcDay(time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC))
	revs := make([]float64, 30)
	app := AppHistory{App: App{Slug: "freeapp", Fees: true}, LastDay: fmtDay(last), Days: days(last, 100000, revs)}
	t.Cleanup(func() { forget("freeapp") })

	publish(historyFor(last, app))

	for _, w := range []string{"1d", "7d", "30d"} {
		if got := testutil.ToFloat64(gTakeRate.WithLabelValues("freeapp", w)); got != 0 {
			t.Errorf("%s take rate = %v, want a published 0", w, got)
		}
		if got := testutil.ToFloat64(gRevenue.WithLabelValues("freeapp", w)); got != 0 {
			t.Errorf("%s revenue = %v, want a published 0", w, got)
		}
	}
	if got := testutil.ToFloat64(gRevDay.WithLabelValues("freeapp")); got != float64(last.Unix()) {
		t.Errorf("revenue day = %v, want the last closed day", got)
	}
}

// A fees adapter a day behind the dexs one must not delete the commission: the
// window ends on the newest day that has both legs, and that day is published.
func TestCommissionAnchorsOnTheNewestDayWithBothLegs(t *testing.T) {
	last := utcDay(time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC))
	revs := make([]float64, 30)
	for i := range revs {
		revs[i] = 500
	}
	revs[0] = -1 // fees adapter has not published the newest day yet
	app := AppHistory{App: App{Slug: "lagging", Fees: true}, LastDay: fmtDay(last), Days: days(last, 100000, revs)}
	t.Cleanup(func() { forget("lagging") })

	publish(historyFor(last, app))

	if got := testutil.ToFloat64(gTakeRate.WithLabelValues("lagging", "1d")); got < 0.49 || got > 0.51 {
		t.Errorf("1d take rate = %.3f%%, want 0.5%% from the day before", got)
	}
	want := float64(last.AddDate(0, 0, -1).Unix())
	if got := testutil.ToFloat64(gRevDay.WithLabelValues("lagging")); got != want {
		t.Errorf("revenue day = %v, want %v", got, want)
	}
	// Volume itself is not held back by the slower leg.
	if got := testutil.ToFloat64(gVolume.WithLabelValues("lagging", "1d")); got != 100000 {
		t.Errorf("1d volume = %v, want 100000 on the volume day", got)
	}
}

// A fees adapter more than 72 h behind publishes no commission at all rather
// than an old one labelled as the latest.
func TestStaleFeesAdapterPublishesNoCommission(t *testing.T) {
	last := utcDay(time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC))
	revs := make([]float64, 30)
	for i := range revs {
		revs[i] = 500
	}
	for i := 0; i < 5; i++ {
		revs[i] = -1
	}
	app := AppHistory{App: App{Slug: "stalefees", Fees: true}, LastDay: fmtDay(last), Days: days(last, 100000, revs)}
	t.Cleanup(func() { forget("stalefees") })

	publish(historyFor(last, app))

	if n := testutil.CollectAndCount(gTakeRate, "trading_app_take_rate_pct"); n != 0 {
		t.Errorf("take rate series = %d, want 0 for a fees adapter five days behind", n)
	}
	if n := testutil.CollectAndCount(gRevDay, "trading_app_revenue_day_unix"); n != 0 {
		t.Errorf("revenue day series = %d, want 0", n)
	}
	if got := testutil.ToFloat64(gVolume.WithLabelValues("stalefees", "1d")); got != 100000 {
		t.Errorf("1d volume = %v, want 100000: volume does not depend on the fees leg", got)
	}
}
