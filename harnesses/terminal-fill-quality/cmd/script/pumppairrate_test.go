package main

import (
	"math"
	"testing"
)

// The weighted rate cannot pair, and that is arithmetic rather than bad luck.
//
// A chain showing both rates yields a mix, say 42.7 bps. No trade ever paid
// that: each paid 40 or 45. So the deposit a weighted rate implies misses the
// real one by thousands of times the tolerance, and no spend can ever pair.
// 1014 did not, with zero ambiguous, which is what a structural miss looks
// like next to a tuning problem.
func TestTheWeightedRateCannotEverPair(t *testing.T) {
	const deposit = 10.0
	// What the router spends when the trade paid exactly 40 bps.
	spend := deposit - (pumpFixedUSD + deposit*0.0040)

	// A plausible mix of the two observed rates.
	const mixed = 0.00427
	implied := (spend + pumpFixedUSD) / (1 - mixed)
	off := math.Abs(implied - deposit)
	if off <= 1e-6 {
		t.Fatalf("a mixed rate landed within tolerance (%.9f), so this test "+
			"no longer describes the failure", off)
	}
	if off < 1e-4 {
		t.Errorf("the miss is only %.9f; it was thousands of times the "+
			"tolerance when measured", off)
	}

	// The exact rate that was actually paid lands on it.
	exact := (spend + pumpFixedUSD) / (1 - 0.0040)
	if math.Abs(exact-deposit) > 1e-9 {
		t.Errorf("the exact rate implied %.9f, want %g", exact, deposit)
	}
}

// Both rates must be tried, since either may be the one a trade paid.
func TestBothRatesAreCandidates(t *testing.T) {
	if len(pumpRatesBps) < 2 {
		t.Fatal("fewer than two rates: there is nothing to try")
	}
	for _, bps := range pumpRatesBps {
		const deposit = 25.0
		spend := deposit - (pumpFixedUSD + deposit*float64(bps)/10000)
		got := (spend + pumpFixedUSD) / (1 - float64(bps)/10000)
		if math.Abs(got-deposit) > 1e-9 {
			t.Errorf("%d bps: a spend of %.6f implied %.9f, want %g",
				bps, spend, got, deposit)
		}
	}
}

// The real Base spend traced by hand must invert to a round deposit.
//
// This is the one case where the true answer is known from the chain rather
// than constructed, so it anchors everything above.
func TestTheTracedBaseSpendInvertsExactly(t *testing.T) {
	const spend = 9.910000
	got := (spend + pumpFixedUSD) / (1 - 0.0040)
	if math.Abs(got-10) > 1e-9 {
		t.Errorf("9.910000 implied %.9f at 40 bps, the chain says 10", got)
	}
	// And at the other rate it must NOT land on a round number, or the two
	// candidates would be indistinguishable and every pair ambiguous.
	other := (spend + pumpFixedUSD) / (1 - 0.0045)
	if math.Abs(other-10) < 1e-6 {
		t.Error("both rates imply the same deposit, so trying both buys nothing")
	}
}
