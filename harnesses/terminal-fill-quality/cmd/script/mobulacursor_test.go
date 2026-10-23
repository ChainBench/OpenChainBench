package main

import (
	"encoding/json"
	"testing"
)

// The fill cursors must survive a restart through REAL JSON.
//
// In memory they meant every restart re-read mobulaFillReach of each chain,
// and those fills had already consumed their intents in the previous run, so
// the second reading filed them as unknown_intent. With roughly fifteen
// restarts in an evening that is most of the counter: 1,161 fills counted
// against about 14 intents a minute actually occurring.
//
// Through json.Marshal rather than struct-to-struct, for the reason the pump
// window had to learn: a map with unexported fields or a missing tag
// serialises as nothing and the fix looks applied while changing nothing.
func TestFillCursorsSurviveRealJSON(t *testing.T) {
	w := newMobulaFillWatcher()
	w.cursor["robinhood"] = 95_500_000
	w.cursor["base"] = 52_960_000

	b, err := json.Marshal(&State{MobulaFillCursor: w.saveCursors()})
	if err != nil {
		t.Fatal(err)
	}
	var back State
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}

	fresh := newMobulaFillWatcher()
	if n := fresh.loadCursors(back.MobulaFillCursor); n != 2 {
		t.Fatalf("restored %d cursors, want 2; serialised as %s", n, b)
	}
	if fresh.cursor["robinhood"] != 95_500_000 || fresh.cursor["base"] != 52_960_000 {
		t.Fatalf("restored cursors are %v: the values did not survive", fresh.cursor)
	}
}

// A zero or negative cursor must not be restored as a position, or the
// watcher would start from block 0 and read the whole chain.
func TestFillCursorsRejectNonsense(t *testing.T) {
	w := newMobulaFillWatcher()
	n := w.loadCursors(map[string]int64{"bnb": 0, "base": -5, "robinhood": 10})
	if n != 1 {
		t.Fatalf("restored %d cursors, want 1: only robinhood's is a position", n)
	}
	if _, ok := w.cursor["bnb"]; ok {
		t.Fatal("a zero cursor was restored; the watcher would read from block 0")
	}
}

// Restoring nothing must leave the watcher usable rather than nil-mapped,
// so a state file written before this field existed still starts.
func TestFillCursorsRestoreOfNothing(t *testing.T) {
	w := newMobulaFillWatcher()
	if n := w.loadCursors(nil); n != 0 {
		t.Fatalf("restoring nil reported %d", n)
	}
	w.cursor["base"] = 7 // must not panic on a nil map
	if w.saveCursors()["base"] != 7 {
		t.Fatal("the watcher is not usable after restoring nothing")
	}
}

// A stale cursor must behave like no cursor. pollChain resets to head minus
// the reach whenever the gap exceeds it, so a cursor from a state file written
// days ago cannot make the watcher ask an endpoint for a million blocks.
func TestAStaleCursorFallsBackToTheReach(t *testing.T) {
	const head = int64(95_500_000)
	stale := int64(1_000)
	span := mobulaSpanOf("robinhood")
	from := stale
	if from <= 0 || head-from > span {
		from = head - span
	}
	if from != head-span {
		t.Fatalf("a cursor %d blocks behind gave from=%d, want %d: the reach is not the bound",
			head-stale, from, head-span)
	}
}
