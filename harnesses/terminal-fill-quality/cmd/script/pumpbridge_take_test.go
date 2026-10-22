package main

import (
	"math/big"
	"testing"
)

// raw turns a decimal string of whole stable units into raw token units without
// going through a float, so a fixture is exactly the number the chain carried.
func raw(t *testing.T, s string, dec int) *big.Int {
	t.Helper()
	f, ok := new(big.Float).SetPrec(200).SetString(s)
	if !ok {
		t.Fatalf("bad fixture %q", s)
	}
	f.Mul(f, new(big.Float).SetPrec(200).SetInt(
		new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(dec)), nil)))
	n, acc := f.Int(nil)
	if acc != big.Exact {
		t.Fatalf("fixture %q is not exact at %d decimals", s, dec)
	}
	return n
}

// Every spend here was read off chain on 2026-10-22 from the routers in
// pumpRouters. The takes are what identifies the schedule, so they are checked
// as whole numbers of basis points rather than as a fitted line.
func TestPumpMatchOnChainFixtures(t *testing.T) {
	cases := []struct {
		name    string
		spent   string
		dec     int
		wantBps int64
		ok      bool
	}{
		// 45 bps: take = 0.05 + 0.0045 * level
		{"10 at 45bps", "9.905000", 6, 45, true},
		{"1 at 45bps", "0.945500", 6, 45, true},
		{"2 at 45bps", "1.941000", 6, 45, true},
		{"10 at 45bps 18dec", "9.905000", 18, 45, true},
		// 40 bps: take = 0.05 + 0.0040 * level
		{"1 at 40bps", "0.946000", 6, 40, true},
		{"2 at 40bps", "1.942000", 6, 40, true},
		{"3 at 40bps", "2.938000", 6, 40, true},
		{"5 at 40bps", "4.930000", 6, 40, true},
		{"10 at 40bps", "9.910000", 6, 40, true},
		{"1 at 40bps 18dec", "0.946000", 18, 40, true},

		// Negatives. These are ordinary trade sizes from the same windows, and
		// the earlier roundness test accepted them as fees, which is exactly the
		// error this version must not repeat.
		{"gap too small", "9.990000", 6, 0, false},
		{"gap between the two rates", "9.907000", 6, 0, false},
		{"a plain trade size", "7.340000", 6, 0, false},
		{"only the fixed part", "9.950000", 6, 0, false},
		{"on a level exactly", "10.000000", 6, 0, false},
		{"far under a level", "6.000000", 6, 0, false},
		{"zero", "0", 6, 0, false},
		{"above the top level", "20000.000000", 6, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			bps, takeBps, ok := pumpMatch(raw(t, c.spent, c.dec), c.dec)
			if ok != c.ok {
				t.Fatalf("%s: matched=%v want %v (bps %d)", c.spent, ok, c.ok, bps)
			}
			if !c.ok {
				return
			}
			if bps != c.wantBps {
				t.Errorf("%s: rate %d bps, want %d", c.spent, bps, c.wantBps)
			}
			// The take as a share of the trade must exceed the rate, since the
			// fixed component is on top of it, and must stay plausible.
			if takeBps <= float64(bps) || takeBps > 1000 {
				t.Errorf("%s: take %.3f bps is not a plausible share at rate %d",
					c.spent, takeBps, bps)
			}
		})
	}
}

// onChainSpends: spends read off the routers on 2026-10-22, with the round
// trade size each came from. These are the only evidence in this file; every
// assertion below is derived from them rather than from the constants.
//
// Grouped by the rate they imply so a line can be fitted per population.
var onChainSpends = map[int64][]struct {
	level int64
	spent string
}{
	40: {{1, "0.946000"}, {2, "1.942000"}, {3, "2.938000"}, {5, "4.930000"}, {10, "9.910000"}},
	45: {{1, "0.945500"}, {2, "1.941000"}, {10, "9.905000"}},
}

// The schedule is recovered FROM the chain, not asserted against itself.
//
// The previous version of this test built each spend out of pumpFixedHundredths
// and pumpRatesBps and then checked the matcher returned them, which passes for
// any constants at all: mutating the rates to {41,46} left it green while the
// on-chain fixtures failed. So the line is fitted to the real spends instead,
// and the constants are what has to agree with it.
func TestScheduleFittedToRealSpends(t *testing.T) {
	for rate, obs := range onChainSpends {
		if len(obs) < 2 {
			t.Fatalf("rate %d: %d spends is not enough to fit a line", rate, len(obs))
		}
		// take = level * slope + intercept, in whole stable units.
		var xs, ys []float64
		for _, o := range obs {
			spent, _ := new(big.Float).SetPrec(200).SetString(o.spent)
			take := new(big.Float).SetPrec(200).SetInt64(o.level)
			take.Sub(take, spent)
			tf, _ := take.Float64()
			xs = append(xs, float64(o.level))
			ys = append(ys, tf)
		}
		// Two ends give the line; every point in between must sit on it, which
		// is what makes this a measurement and not a two-point coincidence.
		n := len(xs) - 1
		slope := (ys[n] - ys[0]) / (xs[n] - xs[0])
		intercept := ys[0] - slope*xs[0]

		if got := slope * 10000; absf(got-float64(rate)) > 1e-6 {
			t.Errorf("rate %d: the chain's own spends imply %.4f bps", rate, got)
		}
		if absf(intercept-0.05) > 1e-9 {
			t.Errorf("rate %d: the chain implies a fixed component of %.9f, not 0.05",
				rate, intercept)
		}
		for i := range xs {
			if r := ys[i] - (slope*xs[i] + intercept); absf(r) > 1e-9 {
				t.Errorf("rate %d: level %g sits %.12f off the line through the others",
					rate, xs[i], r)
			}
		}
		// And the matcher must agree with the line, at the chain's precision.
		for _, o := range obs {
			for _, dec := range []int{6, 18} {
				bps, _, ok := pumpMatch(raw(t, o.spent, dec), dec)
				if !ok || bps != rate {
					t.Errorf("rate %d level %d at %d decimals: matched=%v bps=%d",
						rate, o.level, dec, ok, bps)
				}
			}
		}
	}
}

// Every declared rate must be witnessed on chain.
//
// Adding a rate costs nothing and silently widens the matcher: mutating
// pumpRatesBps to {40, 45, 77} passed the whole suite, and a spurious rate
// turns coincidences into matches and inflates tfq_pump_bridge_schedule_total.
// So a rate with no spend behind it is a test failure, not a judgement call.
func TestEveryDeclaredRateIsWitnessed(t *testing.T) {
	for _, r := range pumpRatesBps {
		obs, ok := onChainSpends[r]
		if !ok || len(obs) == 0 {
			t.Errorf("rate %d bps is declared but no on-chain spend implies it; "+
				"add the evidence or drop the rate", r)
		}
	}
	// The converse too: a rate found on chain and not declared would be read as
	// unmatched, understating what pump takes.
	for r := range onChainSpends {
		found := false
		for _, d := range pumpRatesBps {
			if d == r {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%d bps appears in the on-chain spends but is not declared", r)
		}
	}
}

// The grid must stay sparse enough to be falsifiable.
//
// The whole method rests on a shifted-grid null matching 0.0%, which only holds
// because the levels are the amounts people type. A dense grid would match
// anything, so its size is capped here: the measurement would quietly become a
// coincidence counter otherwise.
func TestLevelGridStaysSparse(t *testing.T) {
	if len(pumpLevels) > 30 {
		t.Errorf("%d levels: too dense for the shifted-grid null to mean anything",
			len(pumpLevels))
	}
	for i := 1; i < len(pumpLevels); i++ {
		if pumpLevels[i] <= pumpLevels[i-1] {
			t.Fatalf("levels must be ascending: %d after %d",
				pumpLevels[i], pumpLevels[i-1])
		}
		// pumpMatch only tries the smallest level above a spend, so two levels
		// closer than the largest possible fee would make a spend unmatchable
		// from the lower one. 9.5% is the widest fee share observed ($1 trades).
		if float64(pumpLevels[i]-pumpLevels[i-1])/float64(pumpLevels[i]) < 0.095 {
			t.Errorf("levels %d and %d are closer than the largest fee share, "+
				"so a spend under the upper one can never be read",
				pumpLevels[i-1], pumpLevels[i])
		}
	}
}

func absf(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

// Every router must name a chain the harness actually polls, or its spends are
// read from an endpoint list that does not exist and the row is silently empty.
func TestPumpRoutersResolveToDeclaredChains(t *testing.T) {
	for _, r := range pumpRouters {
		found := false
		for _, oc := range originChains {
			if oc.slug == r.chain {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("router on %q but no originChain has that slug", r.chain)
		}
		if r.decimals < 2 {
			t.Errorf("%s: %d decimals cannot carry a 0.05 fixed fee exactly",
				r.chain, r.decimals)
		}
	}
}
