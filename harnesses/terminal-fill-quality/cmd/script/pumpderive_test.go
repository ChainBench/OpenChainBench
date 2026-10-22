package main

import (
	"math"
	"testing"
)

func resetPumpCands() {
	pumpCands.Lock()
	pumpCands.byChain = map[string][]pumpCand{}
	pumpCands.Unlock()
}

// feedCands records spends at the precision the chain carries, so a fixture is
// the number a node would return rather than a float that drifted.
func feedCands(t *testing.T, chain string, dec int, spends ...float64) {
	t.Helper()
	scale := math.Pow10(dec)
	for _, s := range spends {
		pumpNoteCandidate(chain, math.Round(s*scale)/scale)
	}
}

// The derivation must find the real fixed component on the real spends.
func TestDerivesTheFixedComponentFromChainData(t *testing.T) {
	resetPumpCands()
	defer resetPumpCands()
	// Spends read off BNB on 2026-10-22, all on the 45 bps schedule.
	feedCands(t, "bnb", 6, 9.905, 4.9275, 24.8375, 497.70, 4977.45)
	got, ok := pumpDerivedFixed("bnb")
	if !ok {
		t.Fatal("not derived from five real spends at five levels")
	}
	if math.Abs(got-0.05) > 1e-9 {
		t.Errorf("derived %.6f, the chain implies 0.05", got)
	}
}

// The proof it is a derivation and not a confirmation: give it a schedule that
// is NOT 0.05 and it must return that one.
//
// If the typed constant leaked into the selection, this returns 0.05 and the
// whole exercise is circular.
func TestDerivationIsNotCircular(t *testing.T) {
	resetPumpCands()
	defer resetPumpCands()
	// A made-up schedule: 0.12 fixed plus 30 bps.
	const F, R = 0.12, 0.0030
	for _, lv := range []float64{5, 10, 50, 100, 500} {
		feedCands(t, "testchain", 6, lv-(F+R*lv))
	}
	got, ok := pumpDerivedFixed("testchain")
	if !ok {
		t.Fatal("a clean synthetic schedule was not derived")
	}
	if math.Abs(got-F) > 1e-6 {
		t.Errorf("derived %.6f from a 0.12 schedule; %s", got,
			map[bool]string{true: "it returned the typed constant, so the " +
				"derivation is circular", false: "neither value"}[math.Abs(got-0.05) < 1e-6])
	}
}

// Noise must not win the vote.
func TestNoiseDoesNotOutvoteTheSchedule(t *testing.T) {
	resetPumpCands()
	defer resetPumpCands()
	feedCands(t, "bnb", 6, 9.905, 4.9275, 24.8375, 497.70, 4977.45)
	// Ordinary trade sizes, which sit under a level but follow no schedule.
	feedCands(t, "bnb", 6, 9.41, 4.62, 23.77, 480.10, 4800.25, 1.93, 2.88)
	got, ok := pumpDerivedFixed("bnb")
	if !ok {
		t.Fatal("not derived once noise was mixed in")
	}
	if math.Abs(got-0.05) > 1e-9 {
		t.Errorf("noise moved the derived fixed component to %.6f", got)
	}
}

// Too little evidence must fall back rather than guess.
func TestDerivationWaitsForEnoughPairs(t *testing.T) {
	resetPumpCands()
	defer resetPumpCands()
	feedCands(t, "arc", 6, 9.905, 4.9275) // one pair only
	if _, ok := pumpDerivedFixed("arc"); ok {
		t.Error("derived a schedule from a single pair")
	}
	if got := pumpFixed("arc"); got != pumpFixedUSD {
		t.Errorf("fallback returned %.6f, want the constant %.6f", got, pumpFixedUSD)
	}
}

// And the gross-up must use whatever was derived, not the constant.
func TestGrossUpUsesTheDerivedFixed(t *testing.T) {
	resetPumpCands()
	resetPumpSeen()
	defer resetPumpCands()
	defer resetPumpSeen()
	const F, R = 0.12, 0.0030
	for _, lv := range []float64{5, 10, 50, 100, 500} {
		feedCands(t, "bnb", 6, lv-(F+R*lv))
	}
	if d, ok := pumpDerivedFixed("bnb"); !ok || math.Abs(d-F) > 1e-6 {
		t.Fatalf("setup: derived %.6f, want %.2f", d, F)
	}
	// 10 minus its own deduction under that schedule.
	spend := 10 - (F + R*10)
	got, ok := pumpGrossUp("pump-fun-bnb", spend)
	if !ok {
		t.Fatal("not grossed up")
	}
	// With the derived 0.12 the answer is near 10; with the typed 0.05 it
	// would fall about 7 cents short.
	if math.Abs(got-10) > 0.03 {
		t.Errorf("grossed %.6f to %.6f, want about 10; the typed constant "+
			"would give %.6f", spend, got, (spend+pumpFixedUSD)/(1-pumpChainRate("bnb")))
	}
}
