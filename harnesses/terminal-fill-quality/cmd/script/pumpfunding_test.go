package main

import (
	"math"
	"testing"
)

// A spend the user funded on this chain must not be grossed up.
//
// The deduction is charged by the router, not by the bridge path, which is why
// 6 of the 7 exactly readable spends were not relayer-sent. But a trade whose
// sender paid for it here has already committed the full amount, and adding a
// deduction nobody took overstates the cost by 62 bps at $25 and 142 at $5,
// in the direction that makes the product look dearer than it is.
func TestUserFundedSpendsAreNotGrossedUp(t *testing.T) {
	for _, spend := range []float64{5, 25, 100, 9.905} {
		got, ok := pumpGrossUpFunded("pump-bridge-bnb", spend, true)
		if ok || got != spend {
			t.Errorf("a user-funded %.3f was grossed to %.6f", spend, got)
		}
		// And the same spend without the funding evidence still is.
		if _, ok := pumpGrossUpFunded("pump-bridge-bnb", spend, false); !ok {
			t.Errorf("%.3f was not grossed up with no funding evidence", spend)
		}
	}
}

// The overstatement the test prevents is worth asserting, so nobody removes
// the guard thinking it costs nothing.
func TestFundingGuardPreventsAMeaningfulError(t *testing.T) {
	for _, c := range []struct {
		spend  float64
		minBps float64
	}{{25, 50}, {5, 120}} {
		grossed, ok := pumpGrossUpFunded("pump-bridge-bnb", c.spend, false)
		if !ok {
			t.Fatalf("%.0f was not grossed", c.spend)
		}
		errBps := 10000 * (grossed - c.spend) / c.spend
		if errBps < c.minBps {
			t.Errorf("at $%.0f the guard saves only %.0f bps, expected over %.0f",
				c.spend, errBps, c.minBps)
		}
	}
}

// The sponsored accounting must not charge the gas twice.
//
// methodVersion 5 exists because v4 added a relayer's gas to the base on
// sponsored swaps, charging those rows twice by a median of 52 bps. The
// gross-up walked back into it: the audit measured network alone at 161.1 bps
// on a $2.03 buy.
//
// For a user committing G with pump deducting D and the relayer paying g out
// of D, the base is G and not G+g, network is g, and the terminal fee is D-g.
// This checks the arithmetic the code now does, on the audit's own figures.
func TestSponsoredGasComesOffTheFeeNotOntoTheBase(t *testing.T) {
	// The swap the audit recomputed from the chain.
	const spend = 40.872485
	grossed, ok := pumpGrossUpFunded("pump-bridge-bnb", spend, false)
	if !ok {
		t.Fatal("not grossed up")
	}
	if math.Abs(grossed-41.097145) > 5e-5 {
		t.Errorf("grossed to %.6f, the audit read 41.097145", grossed)
	}
	deduction := grossed - spend
	if math.Abs(deduction-0.224660) > 5e-5 {
		t.Errorf("deduction %.6f, the audit read 0.224660", deduction)
	}

	// Sponsored: the base is the gross alone, and the gas splits the deduction
	// rather than adding to it.
	const gas = 0.0266 // the audit's figure for this swap
	base := grossed
	terminal := deduction - gas
	if terminal <= 0 {
		t.Fatalf("gas %.4f swallowed the whole deduction %.6f", gas, deduction)
	}
	// Together they must still be exactly what was deducted: nothing invented,
	// nothing lost.
	if math.Abs((terminal+gas)-deduction) > 1e-9 {
		t.Errorf("terminal %.6f plus network %.6f is not the deduction %.6f",
			terminal, gas, deduction)
	}
	// And the base must not have grown by the gas, which was the v4 bug.
	if math.Abs(base-grossed) > 1e-9 {
		t.Errorf("base %.6f moved away from the gross %.6f", base, grossed)
	}
	if bps := 10000 * gas / base; bps > 20 {
		t.Errorf("network reads %.1f bps of the base; the audit saw 161 bps "+
			"when the gas was added on top, so this should now be small", bps)
	}
}
