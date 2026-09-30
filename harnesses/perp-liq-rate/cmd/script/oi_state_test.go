package main

import (
	"encoding/json"
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

// Both halves of the file are keyed the same flat "venue/asset" way. A review
// of the deployed board guessed that the liquidation half might be a nested
// venue-then-asset map while the open-interest half was flat, which would have
// meant only one of them ever came back. It is worth pinning that they cannot
// drift apart, because the symptom of it would be a silent half-restore.
func TestOIStateFileIsFlatlyKeyedOnBothHalves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "w.json")
	now := time.Now()
	nowMs := now.UnixMilli()

	pairs := []*pairRuntime{
		{va: VenueAsset{Venue: "lighter", Asset: "BTC"}, st: newPairState()},
		{va: VenueAsset{Venue: "gains", Asset: "ETH"}, st: newPairState()},
	}
	for _, p := range pairs {
		p.st.oi.Add(nowMs-3600*1000, 1e6)
		p.st.oi.Add(nowMs, 2e6)
		p.st.window.AddEvent(LiqEvent{Key: p.va.Venue + ":1", TimestampMs: nowMs, NotionalUSD: 5e3})
	}
	newOIStateStore(path).save(pairs, now)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var onDisk struct {
		Windows map[string][]map[string]float64 `json:"windows"`
		Liq     map[string][]map[string]any     `json:"liq"`
	}
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("the file is not the shape the loader expects: %v", err)
	}
	for _, key := range []string{"lighter/BTC", "gains/ETH"} {
		if len(onDisk.Windows[key]) != 2 {
			t.Errorf("windows[%q] has %d readings, want 2 under a flat key", key, len(onDisk.Windows[key]))
		}
		if len(onDisk.Liq[key]) != 1 {
			t.Errorf("liq[%q] has %d entries, want 1 under the same flat key", key, len(onDisk.Liq[key]))
		}
	}

	// And the round trip puts both halves back for both rows.
	back := newOIStateStore(path)
	for _, key := range [][2]string{{"lighter", "BTC"}, {"gains", "ETH"}} {
		st := newPairState()
		if n := back.restore(key[0], key[1], st.oi, nowMs); n != 2 {
			t.Errorf("%s/%s restored %d open-interest readings, want 2", key[0], key[1], n)
		}
		if n := back.restoreLiq(key[0], key[1], st, nowMs); n != 1 {
			t.Errorf("%s/%s restored %d liquidations, want 1", key[0], key[1], n)
		}
	}
}
