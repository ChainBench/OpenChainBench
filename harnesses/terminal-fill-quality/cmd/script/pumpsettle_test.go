package main

import "testing"

func resetPumpDepWindow() {
	pumpDepWindow.Lock()
	pumpDepWindow.seen = nil
	pumpDepWindow.Unlock()
}

// A deposit is found by the amount the schedule implies.
func TestDepositIsFoundByItsAmount(t *testing.T) {
	resetPumpDepWindow()
	defer resetPumpDepWindow()
	pumpNoteDeposit(1000, 10.0)
	pumpNoteDeposit(1001, 25.0)
	got, ok := pumpFindDeposit(10.0, 1003, pumpSettleMaxLag)
	if !ok {
		t.Fatal("a deposit of exactly 10 was not found")
	}
	if got.at != 1000 {
		t.Errorf("found the deposit at %d, want 1000", got.at)
	}
}

// Two deposits of the same amount must NOT be resolved to one.
//
// Users type round numbers, so two people sending 10 in the same minute is
// ordinary. Picking either would invent a settlement time, and a latency built
// on invented pairs is worse than no latency.
func TestAmbiguityIsRefusedRatherThanGuessed(t *testing.T) {
	resetPumpDepWindow()
	defer resetPumpDepWindow()
	pumpNoteDeposit(1000, 10.0)
	pumpNoteDeposit(1002, 10.0)
	if _, ok := pumpFindDeposit(10.0, 1005, pumpSettleMaxLag); ok {
		t.Error("two identical deposits resolved to one")
	}
}

// A deposit after its supposed spend, or too far before it, is not a match.
func TestTimeOrderAndWindowAreRespected(t *testing.T) {
	resetPumpDepWindow()
	defer resetPumpDepWindow()
	pumpNoteDeposit(2000, 10.0) // after the spend
	if _, ok := pumpFindDeposit(10.0, 1900, pumpSettleMaxLag); ok {
		t.Error("a deposit later than the spend was accepted")
	}
	resetPumpDepWindow()
	pumpNoteDeposit(1000, 10.0)
	if _, ok := pumpFindDeposit(10.0, 1000+pumpSettleMaxLag+1, pumpSettleMaxLag); ok {
		t.Error("a deposit outside the window was accepted")
	}
}

// Near misses are different deposits, not rounding.
//
// Both sides are integer amounts read off their chains, so a cent apart is
// another trade. Loosening this would pair unrelated users and produce a
// latency distribution out of noise.
func TestNearMissesAreNotPaired(t *testing.T) {
	resetPumpDepWindow()
	defer resetPumpDepWindow()
	pumpNoteDeposit(1000, 10.01)
	if _, ok := pumpFindDeposit(10.0, 1002, pumpSettleMaxLag); ok {
		t.Error("a deposit one cent away was paired")
	}
}

// The window must forget, or it grows for the life of the process and starts
// pairing a spend with something from hours earlier.
func TestWindowDropsWhatIsTooOld(t *testing.T) {
	resetPumpDepWindow()
	defer resetPumpDepWindow()
	pumpNoteDeposit(1000, 10.0)
	// A much later deposit rolls the window past the first one.
	pumpNoteDeposit(1000+pumpDepWindowAge+10, 25.0)
	if _, ok := pumpFindDeposit(10.0, 1002, pumpSettleMaxLag); ok {
		t.Error("a deposit older than the window survived")
	}
	pumpDepWindow.Lock()
	n := len(pumpDepWindow.seen)
	pumpDepWindow.Unlock()
	if n != 1 {
		t.Errorf("window holds %d deposits, want 1", n)
	}
}

// Nothing invalid enters the window.
func TestWindowRejectsNonsense(t *testing.T) {
	resetPumpDepWindow()
	defer resetPumpDepWindow()
	pumpNoteDeposit(0, 10)
	pumpNoteDeposit(1000, 0)
	pumpNoteDeposit(1000, -5)
	pumpDepWindow.Lock()
	n := len(pumpDepWindow.seen)
	pumpDepWindow.Unlock()
	if n != 0 {
		t.Errorf("%d invalid deposits were kept", n)
	}
}

// The chains this can actually answer on must stay declared.
//
// The measurement is only meaningful where a block is shorter than the
// difference being claimed: BNB at 0.45 s and Robinhood Chain at 0.10 s
// qualify, Base at 2.00 s does not. If a router is ever added on a slow chain
// its figure still publishes, under its own label, which is why the label
// exists.
func TestSettleIsLabelledPerChain(t *testing.T) {
	for _, r := range pumpRouters {
		if r.chain == "" {
			t.Error("a router with no chain label would pool fast and slow chains")
		}
	}
	if len(pumpRouters) < 2 {
		t.Error("fewer than two chains: the per-chain label buys nothing")
	}
}
