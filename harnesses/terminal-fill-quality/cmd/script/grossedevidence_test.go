package main

import (
	"math"
	"testing"
)

// A reconstructed trade size must publish what it was reconstructed from.
//
// Without it, a reader checking a pump row against the chain sees the router
// spent 9.905 while the table says 10.00, and concludes the bench is wrong.
// They would be right to: the value was grossed up by the schedule and nothing
// said so. The arithmetic can be correct and still useless if one row cannot
// be reconciled with one transaction.
func TestGrossedRowsCanBeReconciledWithTheChain(t *testing.T) {
	resetPumpSeen()
	defer resetPumpSeen()

	const spend = 9.905
	grossed, ok := pumpGrossUp("pump-bridge-bnb", spend)
	if !ok {
		t.Fatal("not grossed up")
	}
	// What the row would carry.
	sw := Swap{TradeUSD: grossed, GrossedFrom: spend}

	// The reader's check: trade size minus the raw spend is the deduction,
	// and the deduction is the thing pump says it does not charge.
	took := sw.TradeUSD - sw.GrossedFrom
	if took <= 0 {
		t.Fatalf("deduction %.6f is not positive", took)
	}
	// It must match the schedule it was derived from, not an arbitrary gap.
	wantMin := pumpFixedUSD + sw.TradeUSD*40.0/10000.0
	wantMax := pumpFixedUSD + sw.TradeUSD*45.0/10000.0
	if took < wantMin-1e-9 || took > wantMax+1e-9 {
		t.Errorf("deduction %.6f outside the schedule's %.6f to %.6f",
			took, wantMin, wantMax)
	}
	// And the reconstruction has to be reversible: raw plus deduction is the
	// published size, or the row contradicts itself.
	if math.Abs((sw.GrossedFrom+took)-sw.TradeUSD) > 1e-9 {
		t.Error("the row does not add up against itself")
	}
}

// Rows read directly must NOT carry the field.
//
// It is omitempty on purpose: a zero would read as "grossed from nothing"
// rather than "read from the chain", and every row but pump's is read.
func TestDirectlyReadRowsCarryNoReconstruction(t *testing.T) {
	for _, slug := range []string{"fomo", "gmgn-bnb", "axiom-bnb", "banana-gun-ethereum"} {
		if _, ok := pumpGrossUp(slug, 10); ok {
			t.Errorf("%s was grossed up, so it would publish a raw spend it never had", slug)
		}
	}
	// A swap nobody grossed leaves the field at zero, which omitempty drops.
	sw := Swap{TradeUSD: 10}
	if sw.GrossedFrom != 0 {
		t.Error("an ungrossed row carries a reconstruction")
	}
}

// A user-funded spend is published as read, not as reconstructed.
func TestUserFundedRowsAreNotMarkedReconstructed(t *testing.T) {
	if _, ok := pumpGrossUpFunded("pump-bridge-bnb", 25, true); ok {
		t.Error("a user-funded spend was grossed, and would claim a deduction " +
			"nobody took")
	}
}
