package main

import "testing"

func resetPending(t *testing.T) {
	t.Helper()
	pumpPendingSales.Lock()
	pumpPendingSales.by = nil
	pumpPendingSales.Unlock()
	pumpPayoutWindow.Lock()
	pumpPayoutWindow.by = nil
	pumpPayoutWindow.Unlock()
}

// The order of events is the reason this exists. On a sale the EVM leg lands
// FIRST and pump delivers on Solana afterwards, and the native feed reads at
// the head of the chain, so looking the delivery up once at sample time misses
// by construction. Shipped that way it measured 7 of 8 not_held and getting
// worse, which is what a structural miss looks like next to a cold start.
func TestAPendingSaleIsReturnedOnlyOnceItsDeliveryLands(t *testing.T) {
	resetPending(t)
	const order = "7d5ba52289754191ad9c0e624f1573fe"
	now := int64(1_700_000_000)

	pumpNotePendingSale("pump-bridge-robinhood", "0xdead", order, now)

	ready, expired := pumpTakePendingSales("pump-bridge-robinhood", now)
	if len(ready) != 0 || expired != 0 {
		t.Fatalf("returned %v/%d with no delivery held; the sale must wait", ready, expired)
	}

	pumpNotePayout(now+2, order, 0.135031, "Abc")

	ready, expired = pumpTakePendingSales("pump-bridge-robinhood", now+2)
	if len(ready) != 1 || ready[0] != "0xdead" || expired != 0 {
		t.Fatalf("ready = %v, expired = %d; want the one hash once the delivery landed",
			ready, expired)
	}
	// Taken means taken: a second tick must not read the same sale again or
	// the window would hold the row twice.
	if again, _ := pumpTakePendingSales("pump-bridge-robinhood", now+3); len(again) != 0 {
		t.Fatalf("the same sale came back a second time: %v", again)
	}
}

// One terminal's held sale must not be handed to another. The pump routers
// serve several chains and a row only ever re-reads its own transactions.
func TestPendingSalesAreReturnedPerTerminal(t *testing.T) {
	resetPending(t)
	now := int64(1_700_000_000)
	pumpNotePendingSale("pump-bridge-bnb", "0xbnb", "aa11", now)
	pumpNotePendingSale("pump-bridge-base", "0xbase", "bb22", now)
	pumpNotePayout(now, "aa11", 1, "x")
	pumpNotePayout(now, "bb22", 1, "x")

	ready, _ := pumpTakePendingSales("pump-bridge-bnb", now)
	if len(ready) != 1 || ready[0] != "0xbnb" {
		t.Fatalf("bnb got %v, want only its own hash", ready)
	}
	ready, _ = pumpTakePendingSales("pump-bridge-base", now)
	if len(ready) != 1 || ready[0] != "0xbase" {
		t.Fatalf("base got %v, want only its own hash", ready)
	}
}

// A sale whose delivery never arrives is a different fact from one still in
// flight, so it is dropped on the age bound and counted apart rather than held
// for the life of the process.
func TestAPendingSaleExpiresAndIsReportedApart(t *testing.T) {
	resetPending(t)
	now := int64(1_700_000_000)
	pumpNotePendingSale("pump-bridge-arc", "0xold", "cc33", now)

	ready, expired := pumpTakePendingSales("pump-bridge-arc", now+pumpPendingAge+1)
	if len(ready) != 0 || expired != 1 {
		t.Fatalf("ready %v expired %d, want 0 and 1", ready, expired)
	}
	pumpPendingSales.Lock()
	n := len(pumpPendingSales.by)
	pumpPendingSales.Unlock()
	if n != 0 {
		t.Fatalf("%d sales still held after expiry", n)
	}
}

// Reading the same sale twice before its delivery lands must not queue it
// twice, or the row would be produced twice when it finally joins.
func TestANoteOfTheSameOrderTwiceHoldsOneSale(t *testing.T) {
	resetPending(t)
	now := int64(1_700_000_000)
	pumpNotePendingSale("pump-bridge-bnb", "0xfirst", "dd44", now)
	pumpNotePendingSale("pump-bridge-bnb", "0xsecond", "dd44", now+1)
	pumpNotePayout(now, "dd44", 1, "x")

	ready, _ := pumpTakePendingSales("pump-bridge-bnb", now+1)
	if len(ready) != 1 || ready[0] != "0xfirst" {
		t.Fatalf("ready = %v, want the first hash only", ready)
	}
}

// Incomplete entries are not measurements and must not be held.
func TestPendingSalesRefuseIncompleteEntries(t *testing.T) {
	resetPending(t)
	pumpNotePendingSale("", "0xa", "ee55", 1)
	pumpNotePendingSale("pump-bridge-bnb", "", "ee55", 1)
	pumpNotePendingSale("pump-bridge-bnb", "0xa", "", 1)
	pumpPendingSales.Lock()
	n := len(pumpPendingSales.by)
	pumpPendingSales.Unlock()
	if n != 0 {
		t.Fatalf("%d incomplete entries held, want 0", n)
	}
}
