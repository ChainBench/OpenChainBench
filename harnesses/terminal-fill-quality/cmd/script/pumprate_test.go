package main

import (
	"math"
	"testing"
)

// resetPumpSeen clears the tally so each test starts from nothing.
func resetPumpSeen() {
	pumpSeen.Lock()
	pumpSeen.byChain = map[string]map[int64]int{}
	pumpSeen.Unlock()
}

// The rate must follow what the chain showed, not the typed fallback.
//
// pumpFallbackRate multiplied every published pump swap before this: the
// schedule was measured and the gross-up read a constant beside it instead. A
// chain that only ever shows 40 bps must be grossed up at 40, not at 42.5.
func TestRateFollowsTheChainNotTheConstant(t *testing.T) {
	resetPumpSeen()
	defer resetPumpSeen()

	if got := pumpChainRate("bnb"); got != pumpFallbackRate {
		t.Errorf("with nothing seen, rate %v, want the fallback %v", got, pumpFallbackRate)
	}
	// Below the threshold the fallback still stands: a couple of matches is
	// not a mix.
	for i := 0; i < pumpRateMinSeen-1; i++ {
		observePumpSpend("bnb", raw(t, "9.910000", 6), 6) // a 40 bps spend
	}
	if got := pumpChainRate("bnb"); got != pumpFallbackRate {
		t.Errorf("below the threshold, rate %v, want the fallback", got)
	}
	// Past it, the chain's own answer.
	for i := 0; i < 6; i++ {
		observePumpSpend("bnb", raw(t, "9.910000", 6), 6)
	}
	if got := pumpChainRate("bnb"); math.Abs(got-0.0040) > 1e-12 {
		t.Errorf("a chain showing only 40 bps grossed at %v, want 0.0040", got)
	}
}

// A mixed chain lands between its two rates, weighted by how often each appears.
func TestMixedChainIsWeighted(t *testing.T) {
	resetPumpSeen()
	defer resetPumpSeen()
	for i := 0; i < 3; i++ {
		observePumpSpend("base", raw(t, "9.910000", 6), 6) // 40 bps
	}
	for i := 0; i < 7; i++ {
		observePumpSpend("base", raw(t, "9.905000", 6), 6) // 45 bps
	}
	want := (3*40.0 + 7*45.0) / 10 / 10000
	if got := pumpChainRate("base"); math.Abs(got-want) > 1e-12 {
		t.Errorf("rate %v, want %v (3 at 40 bps, 7 at 45)", got, want)
	}
	// And it must sit strictly between the two, never outside.
	if got := pumpChainRate("base"); got < 0.0040 || got > 0.0045 {
		t.Errorf("weighted rate %v fell outside the two observed rates", got)
	}
}

// Chains do not borrow each other's rate.
//
// The mix differs by chain, which is the whole reason for this: grossing
// Robinhood Chain at BNB's rate is the error the constant made.
func TestChainsKeepTheirOwnRate(t *testing.T) {
	resetPumpSeen()
	defer resetPumpSeen()
	for i := 0; i < 8; i++ {
		observePumpSpend("bnb", raw(t, "9.905000", 6), 6)       // 45 bps
		observePumpSpend("robinhood", raw(t, "9.910000", 6), 6) // 40 bps
	}
	b, r := pumpChainRate("bnb"), pumpChainRate("robinhood")
	if math.Abs(b-0.0045) > 1e-12 || math.Abs(r-0.0040) > 1e-12 {
		t.Errorf("bnb %v (want 0.0045), robinhood %v (want 0.0040)", b, r)
	}
	if b == r {
		t.Error("both chains got the same rate from different evidence")
	}
}

// Unmatched spends must not move the rate.
//
// Only an exact read-back says which rate was paid. Letting an ordinary trade
// size vote would turn the measurement back into an average of noise.
func TestUnmatchedSpendsDoNotMoveTheRate(t *testing.T) {
	resetPumpSeen()
	defer resetPumpSeen()
	for i := 0; i < 20; i++ {
		observePumpSpend("arc", raw(t, "7.342100", 6), 6) // reads back to nothing
	}
	if got := pumpChainRate("arc"); got != pumpFallbackRate {
		t.Errorf("unmatched spends moved the rate to %v", got)
	}
}

// The gross-up must use the chain's rate, not a shared one.
func TestGrossUpUsesTheRowsOwnChain(t *testing.T) {
	resetPumpSeen()
	defer resetPumpSeen()
	for i := 0; i < 8; i++ {
		observePumpSpend("robinhood", raw(t, "9.910000", 6), 6) // 40 bps
	}
	got, ok := pumpGrossUp("pump-fun-robinhood", 9.910)
	if !ok {
		t.Fatal("not grossed up")
	}
	want := (9.910 + pumpFixedUSD) / (1 - 0.0040)
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("grossed to %.6f, want %.6f at the chain's own 40 bps", got, want)
	}
	// At 40 bps the answer is 10 to within a rounding; the fallback would miss
	// it by the rate gap.
	if math.Abs(got-10) > 0.005 {
		t.Errorf("grossed to %.6f, expected about 10", got)
	}
}

// Guard the helper that maps a row to its chain: a miss sends the lookup to ""
// and silently returns the fallback for every swap.
func TestEveryPumpRowResolvesToAChain(t *testing.T) {
	for _, term := range evmTerminals {
		if !pumpBridgeRow(term.Slug) {
			continue
		}
		if pumpChainOf(term.Slug) == "" {
			t.Errorf("%s resolves to no chain, so it would always use the fallback",
				term.Slug)
		}
	}
	if pumpChainOf("not-a-row") != "" {
		t.Error("an unknown slug resolved to a chain")
	}
}
