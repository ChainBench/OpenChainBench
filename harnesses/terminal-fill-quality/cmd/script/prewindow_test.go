package main

import "testing"

// The deposit window is NOT in time order, so the oldest deposit cannot be
// read off either end of it.
//
// poll() walks `sigs` as Solana returns them, newest first, so one pass
// inserts descending and the next pass appends a newer block of descending
// entries after it. seen[0] is therefore the newest of the oldest pass and
// seen[len-1] the oldest of the newest pass: neither is the minimum. This is
// why pumpOldestDeposit scans, and this test fails if anyone replaces the
// scan with an index.
func TestOldestDepositDoesNotAssumeTimeOrder(t *testing.T) {
	resetPumpDepWindow()
	// Two passes, each newest-first, as the feed delivers them.
	for _, at := range []int64{5200, 5100, 5000} {
		pumpNoteDeposit(at, 25.0)
	}
	for _, at := range []int64{5500, 5400, 5300} {
		pumpNoteDeposit(at, 30.0)
	}
	if got := pumpOldestDeposit(); got != 5000 {
		t.Fatalf("pumpOldestDeposit() = %d, want 5000: the minimum sits in the middle of the slice", got)
	}
}

// An empty window must report 0, not a floor that would class every spend as
// predating it. The window starts empty after every restart, so this is the
// state the process boots in: with 0 the guard is inert and the existing
// blind/searched split keeps deciding, which is right, because with no
// deposits at all every miss really is our blindness.
func TestOldestDepositOnAnEmptyWindowIsInert(t *testing.T) {
	resetPumpDepWindow()
	if got := pumpOldestDeposit(); got != 0 {
		t.Fatalf("pumpOldestDeposit() on an empty window = %d, want 0", got)
	}
}

// And the floor must rise as the window ages, so that spends which were
// judgeable half an hour ago stop being judged rather than start failing.
func TestOldestDepositFollowsTheRolloff(t *testing.T) {
	resetPumpDepWindow()
	pumpNoteDeposit(1000, 25.0)
	pumpNoteDeposit(1000+pumpDepWindowAge+10, 30.0)
	if got := pumpOldestDeposit(); got != 1000+pumpDepWindowAge+10 {
		t.Fatalf("pumpOldestDeposit() = %d, want the surviving deposit %d: the aged-out one still sets the floor",
			got, 1000+pumpDepWindowAge+10)
	}
}
