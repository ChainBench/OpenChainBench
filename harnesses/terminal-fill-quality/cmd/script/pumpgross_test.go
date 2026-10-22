package main

import (
	"math"
	"testing"
)

// The gross-up must land within a few basis points of the real amount.
//
// These seven spends were read off the router on 2026-10-22 and each reads
// back to a round level exactly, so the user's input is known. That makes them
// the only fixtures where the correction can be scored rather than argued.
//
// The bar is the alternative: leaving the deduction out costs 45 to 545 bps,
// always in the same direction. Anything materially better than that is worth
// publishing; this lands at 2.51 bps, symmetric.
func TestGrossUpLandsNearTheRealAmount(t *testing.T) {
	cases := []struct {
		spent, real float64
	}{
		{9.9050, 10}, {4.9300, 5}, {49.7500, 50}, {4.9275, 5},
		{497.7000, 500}, {24.8375, 25}, {4977.4500, 5000},
	}
	worst := 0.0
	for _, c := range cases {
		got, ok := pumpGrossUp("pump-fun-bnb", c.spent)
		if !ok {
			t.Errorf("%.4f: not grossed up", c.spent)
			continue
		}
		errBps := 10000 * math.Abs(got-c.real) / c.real
		if errBps > 5 {
			t.Errorf("%.4f -> %.6f, %.2f bps off %g, want under 5",
				c.spent, got, errBps, c.real)
		}
		// It must also beat doing nothing, which is the whole point.
		rawBps := 10000 * (c.real - c.spent) / c.real
		if errBps >= rawBps {
			t.Errorf("%.4f: correction is %.2f bps off, no better than the %.2f bps "+
				"of leaving it out", c.spent, errBps, rawBps)
		}
		if errBps > worst {
			worst = errBps
		}
	}
	if worst > 3 {
		t.Errorf("worst residual %.2f bps, expected about 2.51", worst)
	}
}

// Only pump rows are corrected.
//
// Grossing up another product would invent a cost it does not charge, which is
// worse than the understatement this fixes: it would be wrong in the direction
// that makes a competitor look dearer.
func TestGrossUpTouchesOnlyPumpRows(t *testing.T) {
	for _, slug := range []string{"fomo", "axiom-bnb", "gmgn-bnb", "banana-gun-ethereum", ""} {
		if got, ok := pumpGrossUp(slug, 10); ok || got != 10 {
			t.Errorf("pumpGrossUp(%q) changed a non-pump row to %v", slug, got)
		}
	}
	// A pump row is grossed up only where its settlement stable is declared.
	// Without one the funding test cannot tell the user's money from the
	// memecoin the pool hands back, and grossing up blind would add a
	// deduction to a trade the sender may have funded on that chain. Arc,
	// MegaETH and X Layer are in that state until their stable is read.
	grossed := 0
	for _, term := range evmTerminals {
		if len(term.Slug) < 9 || term.Slug[:9] != "pump-fun-" {
			continue
		}
		_, ok := pumpGrossUp(term.Slug, 10)
		if ok != (pumpStableOf(term.Slug) != "") {
			t.Errorf("%s: grossed=%v but stable declared=%v", term.Slug, ok,
				pumpStableOf(term.Slug) != "")
		}
		if ok {
			grossed++
		}
	}
	if grossed == 0 {
		t.Error("no pump row is grossed up at all, so the measurement is off")
	}
}

// Implausible inputs are left alone rather than inflated.
func TestGrossUpRefusesWhatTheScheduleCannotExplain(t *testing.T) {
	for _, v := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		if got, ok := pumpGrossUp("pump-fun-bnb", v); ok {
			t.Errorf("grossed up %v to %v", v, got)
		}
	}
	// A dust trade where the fixed 0.05 would dominate: at $0.10 the correction
	// would be over 50%, which is not this fee, so the cap must refuse it.
	if got, ok := pumpGrossUp("pump-fun-bnb", 0.10); ok {
		t.Errorf("grossed $0.10 up to %.4f; the cap should have refused it", got)
	}
}

// The correction is never larger than the schedule allows.
//
// A gross-up that exceeded the deduction would overstate what pump charges,
// which is the mirror of the bug being fixed and just as publishable a lie.
func TestGrossUpNeverExceedsTheSchedule(t *testing.T) {
	for _, spent := range []float64{1, 5, 9.905, 50, 500, 5000, 50000} {
		got, ok := pumpGrossUp("pump-fun-bnb", spent)
		if !ok {
			continue
		}
		took := got - spent
		maxTake := pumpFixedUSD + got*45.0/10000.0
		minTake := pumpFixedUSD + got*40.0/10000.0
		if took > maxTake+1e-9 || took < minTake-1e-9 {
			t.Errorf("spend %.4f: implied take %.6f outside the schedule's %.6f to %.6f",
				spent, took, minTake, maxTake)
		}
	}
}
