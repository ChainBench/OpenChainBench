package main

import (
	"encoding/json"
	"testing"
	"time"
)

// The settlement window must survive a restart, and the gauges must be
// republished from the restored samples.
//
// This is the one whose loss was visible on the page. Florent kept asking why
// the settlement panel showed only FOMO, and the answer was that every deploy
// reset every route to zero samples: routes fell back under the ten-sample
// floor and the panel showed whichever happened to be above it when the page
// materialised. Reading it in a browser twenty minutes apart gave two
// different pairs of routes.
//
// Restoring the samples is not enough on its own. noteSettle only publishes
// for the route it was called about, so without republishing on load the
// gauges stay empty until each route happens to settle again, which is the
// gap this closes.
func TestSettleWindowSurvivesAndRepublishes(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("pump-bridge", settleTrade, "bnb", 2)
	}
	b, err := json.Marshal(&State{SettleWindow: saveSettleWindow(), SettleSavedAt: time.Now().Unix()})
	if err != nil {
		t.Fatal(err)
	}
	var back State
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}

	resetSettle(t)
	if _, ok := gaugeIfSet(t, gSettleMs, "pump-bridge", settleTrade, "bnb", "mean"); ok {
		t.Fatal("the reset did not clear the gauge, so this test cannot prove anything")
	}
	n := loadSettleWindow(back.SettleWindow, back.SettleSavedAt, time.Now().Unix())
	if n != pumpSettleMin {
		t.Fatalf("restored %d samples, want %d; serialised as %s", n, pumpSettleMin, b)
	}
	// The published figure must be back WITHOUT a new settlement arriving.
	v, ok := gaugeIfSet(t, gSettleMs, "pump-bridge", settleTrade, "bnb", "mean")
	if !ok || v != 2000 {
		t.Fatalf("mean after restore = %v (set %v), want 2000: the gauges were not republished", v, ok)
	}
	if c := gaugeAt(t, gSettleN, "pump-bridge", settleTrade, "bnb"); int(c) != pumpSettleMin {
		t.Fatalf("sample count after restore = %v, want %d", c, pumpSettleMin)
	}
}

// A window saved long ago must NOT come back. The figures are published as
// "last 24 hours", and a process that has been down an hour has missed enough
// that resuming its samples would publish a mean about a period nobody can
// see any more.
func TestStaleSettleWindowIsNotRestored(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("fomo", settleTrade, "base", 1)
	}
	saved := saveSettleWindow()
	resetSettle(t)
	now := time.Now().Unix()
	if n := loadSettleWindow(saved, now-settleMaxRestoreAge-1, now); n != 0 {
		t.Fatalf("restored %d samples from a window older than the limit", n)
	}
	if _, ok := gaugeIfSet(t, gSettleMs, "fomo", settleTrade, "base", "mean"); ok {
		t.Fatal("a stale window published a figure")
	}
}

// The kinds must stay apart across a restart too, or persistence would undo
// the separation that keeps a route's transfers out of its fill figure.
func TestRestoreKeepsTheKindsApart(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("fomo", settleTrade, "bnb", 1)
		noteSettle("fomo", settleFunding, "bnb", 9)
	}
	saved := saveSettleWindow()
	resetSettle(t)
	now := time.Now().Unix()
	if n := loadSettleWindow(saved, now, now); n != 2*pumpSettleMin {
		t.Fatalf("restored %d samples, want %d", n, 2*pumpSettleMin)
	}
	if v := gaugeAt(t, gSettleMs, "fomo", settleTrade, "bnb", "mean"); v != 1000 {
		t.Fatalf("trade mean after restore = %v, want 1000: the kinds pooled", v)
	}
	if v := gaugeAt(t, gSettleMs, "fomo", settleFunding, "bnb", "mean"); v != 9000 {
		t.Fatalf("funding mean after restore = %v, want 9000: the kinds pooled", v)
	}
}

// Restoring nothing must leave a running window alone, so a state file
// written before this field existed cannot wipe samples already collected.
func TestRestoreOfNothingKeepsTheSettleWindow(t *testing.T) {
	resetSettle(t)
	for i := 0; i < pumpSettleMin; i++ {
		noteSettle("phantom", settleTrade, "arc", 3)
	}
	now := time.Now().Unix()
	if n := loadSettleWindow(nil, now, now); n != 0 {
		t.Fatalf("restoring nil reported %d", n)
	}
	if v := gaugeAt(t, gSettleMs, "phantom", settleTrade, "arc", "mean"); v != 3000 {
		t.Fatalf("the live window was lost: mean = %v, want 3000", v)
	}
}
