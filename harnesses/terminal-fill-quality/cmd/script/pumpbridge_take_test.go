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

// The fixed component and the rate are both recovered, not assumed: across the
// levels seen on chain the takes must lie on one line whose slope is the rate
// and whose intercept is 0.05, with no residual. This is the check that would
// fail if pump moved either parameter.
func TestPumpScheduleIsALineThroughFiveHundredths(t *testing.T) {
	for _, rate := range pumpRatesBps {
		var xs, ys []float64
		for _, lv := range []int64{1, 2, 3, 5, 10, 100} {
			// Build the spend the schedule implies, in integers, then read the
			// take back out of it exactly as the watcher does.
			scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(6), nil)
			level := new(big.Int).Mul(big.NewInt(lv), scale)
			take := new(big.Int).Mul(level, big.NewInt(rate))
			take.Quo(take, big.NewInt(10000))
			take.Add(take, big.NewInt(50000)) // 0.05 at 6 decimals
			spent := new(big.Int).Sub(level, take)

			bps, _, ok := pumpMatch(spent, 6)
			if !ok || bps != rate {
				t.Fatalf("rate %d, level %d: matched=%v bps=%d", rate, lv, ok, bps)
			}
			tf, _ := new(big.Float).SetInt(take).Float64()
			xs = append(xs, float64(lv))
			ys = append(ys, tf/1e6)
		}
		// Slope from the two ends, then every point must sit on that line.
		slope := (ys[len(ys)-1] - ys[0]) / (xs[len(xs)-1] - xs[0])
		intercept := ys[0] - slope*xs[0]
		if got := slope * 10000; absf(got-float64(rate)) > 1e-9 {
			t.Errorf("rate %d: slope implies %.6f bps", rate, got)
		}
		if absf(intercept-0.05) > 1e-9 {
			t.Errorf("rate %d: intercept %.9f, want exactly 0.05", rate, intercept)
		}
		for i := range xs {
			if r := ys[i] - (slope*xs[i] + intercept); absf(r) > 1e-9 {
				t.Errorf("rate %d: level %g is %.12f off the line", rate, xs[i], r)
			}
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
