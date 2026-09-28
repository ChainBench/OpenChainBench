package main

import (
	"testing"
	"time"
)

// A counter source restating its window as zero must clear the entry, not
// leave the last non-zero figure published until it ages out a day later.
func TestSlidingWindowRemove(t *testing.T) {
	w := NewSlidingWindow(24 * time.Hour)
	now := time.Now().UnixMilli()
	w.Upsert("nado:BTC:window", now, 26033.19)
	w.Add("ev1", now, 10)
	if !w.Remove("nado:BTC:window") {
		t.Fatal("Remove of a held key should report true")
	}
	if w.Remove("nado:BTC:window") {
		t.Fatal("Remove of an absent key should report false")
	}
	if got := w.Sum(); got != 10 {
		t.Fatalf("Sum = %v, want 10 after removal", got)
	}
	// The index survives the compaction: the remaining key still upserts in
	// place rather than appending a duplicate.
	w.Upsert("ev1", now, 25)
	if got, n := w.Sum(), w.Len(); got != 25 || n != 1 {
		t.Fatalf("Sum=%v Len=%d after upsert on the survivor, want 25 and 1", got, n)
	}
}

// aggregateSource hands the runner one windowed figure, then zero.
type aggregateSource struct{ liq float64 }

func (s *aggregateSource) HasLiquidationSource() bool { return true }
func (s *aggregateSource) FetchOI(string) (float64, error) {
	return 1e6, nil
}
func (s *aggregateSource) FetchVolume24hUSD(string) (float64, error) { return 5e6, nil }
func (s *aggregateSource) FetchLiquidationsSince(string, int64) ([]LiqEvent, error) {
	return []LiqEvent{{Key: "agg:window", NotionalUSD: s.liq, TimestampMs: time.Now().UnixMilli(), Bucket: true, Aggregate: true}}, nil
}

func TestRunTick_ZeroRestatementClearsTheWindow(t *testing.T) {
	src := &aggregateSource{liq: 26033.19}
	va := VenueAsset{Venue: "testagg", Asset: "BTC", Source: src}
	st := newPairState()
	since := time.Now().Add(-24 * time.Hour).UnixMilli()

	if !runTick(va, st, since) {
		t.Fatal("first tick should succeed")
	}
	if got := st.window.Sum(); got < 26033 || got > 26034 {
		t.Fatalf("window = %v, want the aggregate figure", got)
	}
	if !st.noEventDetail {
		t.Fatal("an aggregate row must be marked as carrying no event detail")
	}

	src.liq = 0
	if !runTick(va, st, since) {
		t.Fatal("second tick should succeed")
	}
	if got := st.window.Sum(); got != 0 {
		t.Fatalf("window = %v after a zero restatement, want 0", got)
	}
	if !st.noEventDetail {
		t.Fatal("the no-event-detail mark must stick across a tick with a zero figure")
	}
}
