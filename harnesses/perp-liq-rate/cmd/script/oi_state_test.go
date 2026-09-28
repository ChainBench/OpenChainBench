package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The windows come back across a restart, which is the whole point: open
// interest cannot be backfilled from any source, so a lost window means the
// peak is the peak of the minutes since boot.
func TestOIStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "windows.json")
	now := time.Now()
	nowMs := now.UnixMilli()

	first := newOIStateStore(path)
	pairs := []*pairRuntime{{va: VenueAsset{Venue: "gains", Asset: "ETH"}, st: newPairState()}}
	// A book that was large a day ago and small now, the shape that made the
	// rate wrong when the window was lost.
	pairs[0].st.oi.Add(nowMs-23*3600*1000, 43.7e6)
	pairs[0].st.oi.Add(nowMs-1000, 2.1e6)
	pairs[0].st.window.AddEvent(LiqEvent{Key: "tx:1", TimestampMs: nowMs - 3600*1000,
		NotionalUSD: 12.3e6, CollateralUSD: 200248, Leverage: 108.2})
	first.save(pairs, now)

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("state file not written: %v", err)
	}

	// A restart: a new store, a new pair state.
	second := newOIStateStore(path)
	st := newPairState()
	gotOI := second.restore("gains", "ETH", st.oi, nowMs)
	gotLiq := second.restoreLiq("gains", "ETH", st, nowMs)
	if gotOI != 2 {
		t.Fatalf("restored %d open-interest readings, want 2", gotOI)
	}
	if gotLiq != 1 {
		t.Fatalf("restored %d liquidations, want 1", gotLiq)
	}
	if peak := st.oi.Max(); peak != 43.7e6 {
		t.Fatalf("peak = %v, want the 43.7M the book actually held", peak)
	}
	if sum := st.window.Sum(); sum != 12.3e6 {
		t.Fatalf("liquidation window = %v, want 12.3M", sum)
	}
	if col, ok := st.window.SumCollateral(); !ok || col != 200248 {
		t.Fatalf("collateral = %v,%v want 200248,true", col, ok)
	}
	if lev, ok := st.window.MedianLeverage(); !ok || lev != 108.2 {
		t.Fatalf("leverage = %v,%v want 108.2,true", lev, ok)
	}
	// The restored keys are marked seen, so a source re-reporting the same
	// liquidation after a restart cannot add it twice.
	if st.seen.Add("tx:1", nowMs-3600*1000) {
		t.Fatal("a restored key was not marked seen; a re-report would double count")
	}
}

// Readings that aged out while the harness was down do not come back.
func TestOIStateDropsStaleReadings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "w.json")
	now := time.Now()
	nowMs := now.UnixMilli()

	s := newOIStateStore(path)
	pairs := []*pairRuntime{{va: VenueAsset{Venue: "aster", Asset: "BTC"}, st: newPairState()}}
	pairs[0].st.oi.Add(nowMs-2000, 5e6)
	s.save(pairs, now)

	// Come back two days later.
	later := nowMs + 48*3600*1000
	st := newPairState()
	if n := newOIStateStore(path).restore("aster", "BTC", st.oi, later); n != 0 {
		t.Fatalf("restored %d stale readings, want 0", n)
	}
}

// No path, no persistence, no failure: the harness runs as it did before.
func TestOIStateWithoutAPathIsQuiet(t *testing.T) {
	s := newOIStateStore("")
	pairs := []*pairRuntime{{va: VenueAsset{Venue: "gmx", Asset: "ETH"}, st: newPairState()}}
	pairs[0].st.oi.Add(time.Now().UnixMilli(), 1e6)
	s.save(pairs, time.Now()) // must not panic
	st := newPairState()
	if n := s.restore("gmx", "ETH", st.oi, time.Now().UnixMilli()); n != 0 {
		t.Fatalf("restored %d with no path, want 0", n)
	}
}

// An unreadable file starts empty rather than refusing to boot.
func TestOIStateIgnoresRubbish(t *testing.T) {
	path := filepath.Join(t.TempDir(), "w.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	st := newPairState()
	if n := newOIStateStore(path).restore("gains", "ETH", st.oi, time.Now().UnixMilli()); n != 0 {
		t.Fatalf("restored %d from rubbish, want 0", n)
	}
}

// The span check is what decides whether the peak is a 24h peak. An hour of
// readings is not, however many of them there are.
func TestOISpansWindow(t *testing.T) {
	nowMs := time.Now().UnixMilli()
	tick := 5 * time.Minute

	short := NewSampleWindow(windowSpan)
	for i := 0; i < 13; i++ {
		short.Add(nowMs-int64(i)*tick.Milliseconds(), 1e6)
	}
	if oiSpansWindow(short, nowMs, tick) {
		t.Fatal("an hour of readings reported as covering the day")
	}

	full := NewSampleWindow(windowSpan)
	full.Add(nowMs-windowSpan.Milliseconds()+tick.Milliseconds(), 1e6)
	for i := 0; i < 12; i++ {
		full.Add(nowMs-int64(i)*tick.Milliseconds(), 1e6)
	}
	if !oiSpansWindow(full, nowMs, tick) {
		t.Fatal("a full span of readings reported as short")
	}

	// Enough span but too few readings is still not a denominator.
	sparse := NewSampleWindow(windowSpan)
	sparse.Add(nowMs-windowSpan.Milliseconds()+1000, 1e6)
	sparse.Add(nowMs, 2e6)
	if oiSpansWindow(sparse, nowMs, tick) {
		t.Fatal("two readings a day apart reported as a window")
	}
}
