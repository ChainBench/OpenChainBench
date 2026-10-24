package main

import (
	"math"
	"testing"
)

// Gas the app sends back is value received, so it must lower the loss by its
// own size and no more.
//
// The audited pump.fun swap: the user gave 0.162995 USDC worth of quote and
// the sponsor returned 0.00148844 SOL, which is 0.154299 USDC at the route's
// hop rate. Published 351.45 bps; with the top-up credited, about 199.7.
func TestATopUpIsCreditedAsValueReceived(t *testing.T) {
	ref := 1.0
	base := Swap{Tokens: 100, QuoteUSD: 1, UserQ: 120, Side: "buy", Quote: "USDC"}
	withTopUp := base
	withTopUp.UserSolRecv = 10

	base.finalize(&ref, 0, "reserves")
	withTopUp.finalize(&ref, 0, "reserves")

	if base.LossBps == nil || withTopUp.LossBps == nil {
		t.Fatal("both rows must price")
	}
	// value 100 of 120 given is 1666.7 bps lost; value 110 is 833.3.
	if math.Abs(*base.LossBps-1666.67) > 1 {
		t.Fatalf("baseline loss %.2f, want about 1666.67", *base.LossBps)
	}
	if math.Abs(*withTopUp.LossBps-833.33) > 1 {
		t.Fatalf("with the top-up credited loss is %.2f, want about 833.33", *withTopUp.LossBps)
	}
	if *withTopUp.LossBps >= *base.LossBps {
		t.Fatal("crediting a top-up must lower the loss")
	}
}

// A swap with no top-up must be untouched, or this change would move every
// figure on the board instead of the ones that received gas.
func TestNoTopUpLeavesTheLossAlone(t *testing.T) {
	ref := 1.0
	a := Swap{Tokens: 100, QuoteUSD: 1, UserQ: 120, Side: "buy", Quote: "USDC"}
	b := a
	b.UserSolRecv = 0
	a.finalize(&ref, 0, "reserves")
	b.finalize(&ref, 0, "reserves")
	if a.LossBps == nil || b.LossBps == nil || *a.LossBps != *b.LossBps {
		t.Fatal("a zero top-up changed the loss")
	}
}

// The method version has to move with the formula. Rows priced under the old
// one cannot be replayed, because they never recorded the value this needs,
// so they must be dropped rather than restated: statsFor skips any swap whose
// Method is not the current one, and that is the mechanism relied on here.
func TestMethodVersionMovedWithTheFormula(t *testing.T) {
	if methodVersion < 6 {
		t.Fatalf("methodVersion is %d: rows priced before the top-up fix would sit beside rows priced after it", methodVersion)
	}
}
