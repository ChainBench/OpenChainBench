package main

import (
	"encoding/json"
	"testing"
	"time"
)

// The round trip goes through REAL JSON, not through the structs.
//
// That is the whole point of the test. pumpDep's fields are unexported, so a
// first version of this persisted it directly: encoding/json would have
// written a list of empty objects, the load would have found entries with
// at=0, the age filter would have dropped every one, and the window would
// have come back empty exactly as it does today. A fix that looks applied and
// changes nothing is worse than no fix, because nobody looks again. Only a
// test that marshals catches it.
func TestDepositWindowSurvivesRealJSON(t *testing.T) {
	resetPumpDepWindow()
	now := time.Now().Unix()
	pumpNoteDeposit(now-60, 25.5)
	pumpNoteDeposit(now-30, 101.25)

	b, err := json.Marshal(&State{PumpDeposits: pumpSaveDeposits()})
	if err != nil {
		t.Fatal(err)
	}
	var back State
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}

	resetPumpDepWindow()
	if n := pumpLoadDeposits(back.PumpDeposits, now); n != 2 {
		t.Fatalf("restored %d deposits, want 2; serialised form was %s", n, b)
	}
	// And the values have to be the ones that went in, or the pairing
	// searches for amounts that never existed.
	d, why, inRange := pumpFindDeposit(101.25, now-29, 300)
	if why != "unique" || d.at != now-30 {
		t.Fatalf("lookup after restore: why=%q at=%d inRange=%d, want a unique hit at %d",
			why, d.at, inRange, now-30)
	}
}

// A deposit older than the window's reach must not come back. A long outage
// would otherwise resurrect deposits whose spends landed while we were down,
// and they would pair against whatever arrived next.
func TestRestoreAppliesTheAgeRule(t *testing.T) {
	resetPumpDepWindow()
	now := time.Now().Unix()
	in := []pumpDepRecord{
		{At: now - 10, Amount: 5},
		{At: now - pumpDepWindowAge - 1, Amount: 6},
		{At: 0, Amount: 7},
		{At: now - 20, Amount: 0},
	}
	if n := pumpLoadDeposits(in, now); n != 1 {
		t.Fatalf("restored %d, want 1: only the fresh, valid deposit qualifies", n)
	}
	if got := pumpOldestDeposit(); got != now-10 {
		t.Fatalf("oldest restored deposit = %d, want %d", got, now-10)
	}
}

// An empty or absent list must leave the window alone rather than clearing
// it, so a state file written before this field existed does not wipe a
// window the feed has already filled.
func TestRestoreOfNothingKeepsTheWindow(t *testing.T) {
	resetPumpDepWindow()
	now := time.Now().Unix()
	pumpNoteDeposit(now-5, 42)
	if n := pumpLoadDeposits(nil, now); n != 0 {
		t.Fatalf("restoring nil reported %d restored", n)
	}
	if got := pumpOldestDeposit(); got != now-5 {
		t.Fatalf("the live deposit was lost: oldest = %d, want %d", got, now-5)
	}
}
