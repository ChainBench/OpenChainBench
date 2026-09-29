package main

// window_forfeit_test.go: the forfeited-collateral arithmetic, the band split,
// and the one rule the whole group turns on: a feed that cannot report these
// quantities publishes nothing, not a zero.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func forfeitEvent(key string, tsMs int64, notional, collateral, lev, lossPct, returned float64) LiqEvent {
	return LiqEvent{Key: key, TimestampMs: tsMs, NotionalUSD: notional,
		CollateralUSD: collateral, Leverage: lev,
		HasForfeitDetail: true, LossAtTriggerPct: lossPct, ReturnedUSD: returned}
}

// The arithmetic on the numbers measured on Gains over the three days to
// 2026-09-29: a median loss of 60.0% of margin, nothing returned, so a median
// forfeit of 40.0 points.
func TestForfeitStats_MedianOverTheWindow(t *testing.T) {
	w := NewSlidingWindow(windowSpan)
	now := time.Now().UnixMilli()
	for i, loss := range []float64{47.1, 57.0, 60.0, 68.8, 88.0} {
		w.AddEvent(forfeitEvent("k"+string(rune('a'+i)), now-int64(i)*1000, 1000, 100, 80, loss, 0))
	}
	forf, loss, ret, n := w.ForfeitStats()
	if n != 5 {
		t.Fatalf("n = %d, want 5", n)
	}
	if loss != 60 {
		t.Fatalf("median loss = %.2f, want 60", loss)
	}
	if ret != 0 {
		t.Fatalf("median returned = %.2f, want 0", ret)
	}
	if forf != 40 {
		t.Fatalf("median forfeited = %.2f, want 40", forf)
	}
}

// The three published figures are three independent medians over the same
// closes, so they do not add to 100, and nothing may "fix" that by deriving one
// from the other two. A median is not linear: the real GMX day below reads 63.3
// lost, 18.6 returned and 15.4 forfeited, and 100 - 63.3 - 18.6 is 18.1.
func TestForfeitStats_TheThreeMediansDoNotAddToAHundred(t *testing.T) {
	w := NewSlidingWindow(windowSpan)
	now := time.Now().UnixMilli()
	// Three closes whose per-close arithmetic is exact and whose medians are
	// each taken from a different close.
	for i, c := range []struct{ loss, ret float64 }{
		{90, 2},  // forfeits 8
		{60, 20}, // forfeits 20
		{30, 60}, // forfeits 10
	} {
		w.AddEvent(forfeitEvent("k"+string(rune('a'+i)), now-int64(i)*1000,
			1000, 100, 50, c.loss, c.ret))
	}
	forf, loss, ret, n := w.ForfeitStats()
	if n != 3 {
		t.Fatalf("n = %d, want 3", n)
	}
	if loss != 60 || ret != 20 {
		t.Fatalf("medians = loss %.2f returned %.2f, want 60 and 20", loss, ret)
	}
	// The median forfeit is the middle of {8, 20, 10}, which is 10, not the
	// 20 that subtracting the two medians would give.
	if forf != 10 {
		t.Fatalf("median forfeited = %.2f, want 10 (the median of 8, 20, 10)", forf)
	}
	if forf == 100-loss-ret {
		t.Fatal("the forfeited median must not be derived from the other two medians")
	}
}

// The medians, not the aggregate ratio. One 200,000 dollar position beside a
// hundred small ones must not be the venue's whole answer: that position is the
// largest Gains liquidation of the three days measured and its own forfeit was
// 48.8 points, well away from the field's 40.0.
func TestForfeitStats_OneWhaleDoesNotCarryTheRow(t *testing.T) {
	w := NewSlidingWindow(windowSpan)
	now := time.Now().UnixMilli()
	for i := 0; i < 9; i++ {
		w.AddEvent(forfeitEvent("small"+string(rune('a'+i)), now-int64(i)*1000, 500, 50, 80, 60, 0))
	}
	w.AddEvent(forfeitEvent("whale", now, 21_667_243, 200_227.73, 108.213, 51.2437, 0))
	forf, _, _, n := w.ForfeitStats()
	if n != 10 {
		t.Fatalf("n = %d, want 10", n)
	}
	if math.Abs(forf-40) > 0.001 {
		t.Fatalf("median forfeited = %.4f, want 40: the whale is one of ten, not the answer", forf)
	}
}

// An absent measurement is absent. An event with no forfeit detail contributes
// nothing and does not drag the count up, so a venue whose feed carries no
// position never publishes a share at all.
func TestForfeitStats_EventsWithoutDetailAreNotCounted(t *testing.T) {
	w := NewSlidingWindow(windowSpan)
	now := time.Now().UnixMilli()
	w.Add("tape1", now, 5000)   // a trade tape row: size and price only
	w.Add("tape2", now-1, 7000) // likewise
	if forf, loss, ret, n := w.ForfeitStats(); n != 0 || forf != 0 || loss != 0 || ret != 0 {
		t.Fatalf("a window of tape rows reported n=%d forf=%.2f loss=%.2f ret=%.2f, want all zero and n=0",
			n, forf, loss, ret)
	}
	// One event that does carry it makes the row a measurement over exactly
	// that one event, and the count says so.
	w.AddEvent(forfeitEvent("chain1", now-2, 1000, 100, 50, 70, 10))
	forf, loss, ret, n := w.ForfeitStats()
	if n != 1 {
		t.Fatalf("n = %d, want 1", n)
	}
	if loss != 70 || ret != 10 || forf != 20 {
		t.Fatalf("shares = loss %.2f returned %.2f forfeited %.2f, want 70 / 10 / 20", loss, ret, forf)
	}
}

// A returned share of zero is a real reading, and the common one: Gains and
// Ostium returned nothing on every liquidation measured. It must be
// distinguishable from "the source never said", which is what the flag is for.
func TestForfeitStats_ZeroReturnedIsAMeasurement(t *testing.T) {
	w := NewSlidingWindow(windowSpan)
	now := time.Now().UnixMilli()
	w.AddEvent(forfeitEvent("k1", now, 1000, 100, 50, 60, 0))
	_, _, ret, n := w.ForfeitStats()
	if n != 1 || ret != 0 {
		t.Fatalf("n = %d returned = %.2f, want 1 and 0", n, ret)
	}
	// The same event without the flag reports nothing at all.
	w2 := NewSlidingWindow(windowSpan)
	e := forfeitEvent("k1", now, 1000, 100, 50, 60, 0)
	e.HasForfeitDetail = false
	w2.AddEvent(e)
	if _, _, _, n2 := w2.ForfeitStats(); n2 != 0 {
		t.Fatalf("n = %d without the flag, want 0", n2)
	}
}

// The band split, on the shape Gains actually shows: the forfeit grows with
// leverage. The bounds are inclusive at the top, so 10x is in 0-10x and 100x is
// in 50-100x.
func TestForfeitByBand_BoundsAndCounts(t *testing.T) {
	w := NewSlidingWindow(windowSpan)
	now := time.Now().UnixMilli()
	cases := []struct {
		lev, loss float64
		band      string
	}{
		{5, 78, "0-10x"},
		{10, 78, "0-10x"},
		{10.1, 70.7, "10-25x"},
		{25, 70.7, "10-25x"},
		{40, 68.7, "25-50x"},
		{50, 68.7, "25-50x"},
		{75, 57.1, "50-100x"},
		{100, 57.1, "50-100x"},
		{100.1, 59.1, "100x+"},
		{500, 59.1, "100x+"},
	}
	for i, c := range cases {
		if got := leverageBandOf(c.lev); got != c.band {
			t.Fatalf("%gx landed in %q, want %q", c.lev, got, c.band)
		}
		w.AddEvent(forfeitEvent("k"+string(rune('a'+i)), now-int64(i)*1000, 1000, 100, c.lev, c.loss, 0))
	}
	bands := w.ForfeitByBand()
	if len(bands) != 5 {
		t.Fatalf("got %d bands, want 5", len(bands))
	}
	for _, want := range []struct {
		band      string
		forfeited float64
		n         int
	}{
		{"0-10x", 22, 2},
		{"10-25x", 29.3, 2},
		{"25-50x", 31.3, 2},
		{"50-100x", 42.9, 2},
		{"100x+", 40.9, 2},
	} {
		got := bands[want.band]
		if got.N != want.n {
			t.Fatalf("band %s: n = %d, want %d", want.band, got.N, want.n)
		}
		if math.Abs(got.Forfeited-want.forfeited) > 0.01 {
			t.Fatalf("band %s: forfeited = %.2f, want %.2f", want.band, got.Forfeited, want.forfeited)
		}
	}
	// The forfeit has to be monotone here, which is the finding the band split
	// exists to show.
	if bands["0-10x"].Forfeited >= bands["100x+"].Forfeited {
		t.Fatal("the forfeit should grow with leverage on this data")
	}
}

// A source that reports no leverage cannot be placed in a band, and its events
// must not pile into one.
func TestForfeitByBand_SkipsEventsWithNoLeverage(t *testing.T) {
	w := NewSlidingWindow(windowSpan)
	now := time.Now().UnixMilli()
	e := forfeitEvent("k1", now, 1000, 100, 0, 60, 0)
	w.AddEvent(e)
	if got := leverageBandOf(0); got != "" {
		t.Fatalf("a missing leverage named band %q, want the empty string", got)
	}
	if bands := w.ForfeitByBand(); len(bands) != 0 {
		t.Fatalf("got %d bands from an event with no leverage, want 0", len(bands))
	}
	// It still counts in the overall shares, which do not need a leverage.
	if _, _, _, n := w.ForfeitStats(); n != 1 {
		t.Fatalf("n = %d, want 1", n)
	}
}

// The window survives a restart with its forfeit detail intact, flag included:
// without the flag on disk, Gains and Ostium rows would come back as "the
// source never said" and the whole group would blank for a day after a deploy.
func TestForfeitStats_SurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	now := time.Now()
	nowMs := now.UnixMilli()

	pairs := []*pairRuntime{{
		va: VenueAsset{Venue: "gains", Asset: "ETH"},
		st: newPairState(),
	}}
	pairs[0].st.window.AddEvent(forfeitEvent("tx:1", nowMs-60_000, 21_667_243, 200_227.73, 108.213, 51.2437, 0))
	pairs[0].st.window.AddEvent(forfeitEvent("tx:2", nowMs-120_000, 1000, 100, 8, 78, 0))
	pairs[0].st.oi.Add(nowMs, 43_541_865)

	store := newOIStateStore(path)
	store.save(pairs, now)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("state not written: %v", err)
	}
	// The flag has to be on disk under its own key; a reader that infers it
	// from a non-zero returned amount gets Gains wrong every time.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f oiStateFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse: %v", err)
	}
	for _, e := range f.Liq["gains/ETH"] {
		if !e.HasForfeit {
			t.Fatalf("entry %s lost its forfeit flag on disk", e.Key)
		}
	}

	restored := newOIStateStore(path)
	st := newPairState()
	if n := restored.restoreLiq("gains", "ETH", st, nowMs); n != 2 {
		t.Fatalf("restored %d liquidations, want 2", n)
	}
	forf, loss, ret, n := st.window.ForfeitStats()
	if n != 2 {
		t.Fatalf("n after restore = %d, want 2", n)
	}
	if ret != 0 {
		t.Fatalf("returned after restore = %.2f, want 0", ret)
	}
	if math.Abs(loss-(51.2437+78)/2) > 0.001 || math.Abs(forf-(48.7563+22)/2) > 0.001 {
		t.Fatalf("shares after restore = loss %.4f forfeited %.4f, want the medians of the two", loss, forf)
	}
	bands := st.window.ForfeitByBand()
	if bands["100x+"].N != 1 || bands["0-10x"].N != 1 {
		t.Fatalf("bands after restore: %+v", bands)
	}
}

// The gauges are deleted, not zeroed, when a row holds no forced close that
// carried the detail. This is the rule the rest of the group rests on: six of
// the eleven feeds here cannot report these quantities, and a 0.0% on such a row
// would put them at the top of a "least collateral forfeited" reading.
func TestSetForfeitShares_AbsentRatherThanZero(t *testing.T) {
	const venue, asset = "forfeit-test-venue", "ETH"
	setForfeitShares(venue, asset, 40, 60, 0, 12, true)
	if got := gaugeVal(t, liqForfeited, row(venue, asset)); got != 40 {
		t.Fatalf("forfeited = %v, want 40", got)
	}
	if got := gaugeVal(t, liqForfeitEvents, row(venue, asset)); got != 12 {
		t.Fatalf("events = %v, want 12", got)
	}

	// A venue whose feed carries the position and saw no forced close: the
	// medians go, and the count stays at zero to say the row was looked at.
	setForfeitShares(venue, asset, 0, 0, 0, 0, true)
	for name, g := range map[string]*prometheus.GaugeVec{
		"forfeited": liqForfeited, "loss": liqLossAtTrigger, "returned": liqReturned,
	} {
		if _, ok := gaugeLookup(t, g, row(venue, asset)); ok {
			t.Fatalf("%s still publishes a median with nothing to take a median of", name)
		}
	}
	if got := gaugeVal(t, liqForfeitEvents, row(venue, asset)); got != 0 {
		t.Fatalf("events = %v, want 0 for a venue that can report and saw nothing", got)
	}

	// A venue whose feed cannot carry the position publishes nothing at all,
	// count included: an empty window and an unmeasurable feed must not read
	// the same, and neither may read as 0.0% forfeited.
	setForfeitShares(venue, asset, 0, 0, 0, 0, false)
	for name, g := range map[string]*prometheus.GaugeVec{
		"forfeited": liqForfeited, "loss": liqLossAtTrigger,
		"returned": liqReturned, "events": liqForfeitEvents,
	} {
		if _, ok := gaugeLookup(t, g, row(venue, asset)); ok {
			t.Fatalf("%s still publishes a series for a feed that cannot report it", name)
		}
	}
}

// The three venues that carry the position say so, and the rest do not. This is
// what lets the runner tell an empty window from an unmeasurable feed.
func TestCarriesPositionDetail_OnlyTheThreeVenues(t *testing.T) {
	for _, c := range []struct {
		name string
		src  Source
		want bool
	}{
		{"gains", NewGainsMulti(NewGains("http://x"), NewGainsArbitrum("http://x")), true},
		{"gmx", NewGMX(), true},
		{"ostium", NewOstium(), true},
		{"hyperliquid", NewHyperliquid(), false},
		{"dydx", NewDydx(), false},
		{"paradex", NewParadex(), false},
		{"orderly", NewOrderly(), false},
		{"lighter", NewLighter(), false},
		{"aster", NewAster(), false},
		{"nado", NewNado(), false},
		{"aevo", NewAevo(), false},
	} {
		if got := carriesPositionDetail(c.src); got != c.want {
			t.Errorf("%s carriesPositionDetail = %v, want %v", c.name, got, c.want)
		}
	}
}

// A band that empties loses its series too, rather than keeping yesterday's
// median beside a count that is gone.
func TestSetForfeitBands_EmptyBandsAreDeleted(t *testing.T) {
	const venue, asset = "forfeit-band-venue", "BTC"
	full := map[string]struct {
		Forfeited float64
		N         int
	}{"0-10x": {22, 35}, "100x+": {40.9, 375}}
	setForfeitBands(venue, asset, full)
	if got := gaugeVal(t, liqForfeitedByBand, bandRow(venue, asset, "100x+")); got != 40.9 {
		t.Fatalf("100x+ = %v, want 40.9", got)
	}
	if _, ok := gaugeLookup(t, liqForfeitedByBand, bandRow(venue, asset, "50-100x")); ok {
		t.Fatal("a band with no events should have no series")
	}

	setForfeitBands(venue, asset, map[string]struct {
		Forfeited float64
		N         int
	}{"0-10x": {22, 35}})
	if _, ok := gaugeLookup(t, liqForfeitedByBand, bandRow(venue, asset, "100x+")); ok {
		t.Fatal("a band that emptied kept its median")
	}
	if _, ok := gaugeLookup(t, liqEventsByBand, bandRow(venue, asset, "100x+")); ok {
		t.Fatal("a band that emptied kept its count")
	}
}

// gaugeVal reads one labelled gauge, failing when the series is absent.
func gaugeVal(t *testing.T, g *prometheus.GaugeVec, want map[string]string) float64 {
	t.Helper()
	v, ok := gaugeLookup(t, g, want)
	if !ok {
		t.Fatalf("no series for %v", want)
	}
	return v
}

// gaugeLookup matches on label names rather than on position: a collected
// metric lists its labels in alphabetical order, so {venue, chain} arrives as
// chain then venue and a positional match silently finds nothing.
func gaugeLookup(t *testing.T, g *prometheus.GaugeVec, want map[string]string) (float64, bool) {
	t.Helper()
	ch := make(chan prometheus.Metric, 256)
	g.Collect(ch)
	close(ch)
	for m := range ch {
		var pb dto.Metric
		if err := m.Write(&pb); err != nil {
			t.Fatalf("write metric: %v", err)
		}
		got := make(map[string]string, len(pb.Label))
		for _, l := range pb.Label {
			got[l.GetName()] = l.GetValue()
		}
		if len(got) != len(want) {
			continue
		}
		match := true
		for k, v := range want {
			if got[k] != v {
				match = false
				break
			}
		}
		if match {
			return pb.GetGauge().GetValue(), true
		}
	}
	return 0, false
}

func row(venue, asset string) map[string]string {
	return map[string]string{"venue": venue, "chain": asset}
}

func bandRow(venue, asset, band string) map[string]string {
	return map[string]string{"venue": venue, "chain": asset, "band": band}
}
