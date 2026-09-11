package main

import (
	"math"
	"testing"
)

func near(a, b, tol float64) bool { return math.Abs(a-b) <= tol }

// The worked example from the issue text, to the cent.
func TestAllInPremiumWorkedExample(t *testing.T) {
	got, err := AllInPremiumBps(500, 0.0048, 100000)
	if err != nil {
		t.Fatal(err)
	}
	if !near(got, 416.67, 0.01) {
		t.Fatalf("got %.4f bps, want 416.67", got)
	}
}

func TestAllInPremiumRejectsZeroes(t *testing.T) {
	for _, c := range [][3]float64{{0, 1, 1}, {1, 0, 1}, {1, 1, 0}, {-1, 1, 1}} {
		if _, err := AllInPremiumBps(c[0], c[1], c[2]); err == nil {
			t.Errorf("expected error for %v", c)
		}
	}
}

// A provider quoting exactly at spot has 0 bps premium; one quoting
// below spot goes negative and is reported as such, not clamped.
func TestAllInPremiumSignAndZero(t *testing.T) {
	z, _ := AllInPremiumBps(100, 0.001, 100000)
	if !near(z, 0, 1e-9) {
		t.Errorf("at spot should be 0, got %v", z)
	}
	n, _ := AllInPremiumBps(100, 0.00101, 100000)
	if n >= 0 {
		t.Errorf("below spot should be negative, got %v", n)
	}
}

func TestDeclaredAndHidden(t *testing.T) {
	q := NormalizedQuote{FiatIn: 500, FeeProvider: 5, FeeNetwork: 1.5, FeePartner: 0}
	d, err := DeclaredFeeBps(q)
	if err != nil {
		t.Fatal(err)
	}
	// 6.5 / 500 = 1.3 % = 130 bps
	if !near(d, 130, 1e-9) {
		t.Fatalf("declared = %v, want 130", d)
	}
	// all-in 416.67 with 130 declared leaves 286.67 of spread the provider
	// never named a fee.
	if h := HiddenSpreadBps(416.67, d); !near(h, 286.67, 1e-6) {
		t.Fatalf("hidden = %v, want 286.67", h)
	}
}

// Ramp returns crypto in base units. 0.0048 BTC is 480000 satoshi;
// 1.5 ETH is 1.5e18 wei; 250 USDC is 250e6.
func TestFromBaseUnits(t *testing.T) {
	cases := []struct {
		asset string
		raw   float64
		want  float64
	}{
		{"btc", 480000, 0.0048},
		{"eth", 1.5e18, 1.5},
		{"usdc", 250e6, 250},
	}
	for _, c := range cases {
		got := FromBaseUnits(c.raw, AssetDecimals(c.asset))
		if !near(got, c.want, 1e-12) {
			t.Errorf("%s: %v → %v, want %v", c.asset, c.raw, got, c.want)
		}
	}
}

// End to end on the Ramp shape: satoshi in, bps out, must land on the
// worked example.
func TestRampShapeEndToEnd(t *testing.T) {
	cryptoOut := FromBaseUnits(480000, AssetDecimals("btc"))
	got, _ := AllInPremiumBps(500, cryptoOut, 100000)
	if !near(got, 416.67, 0.01) {
		t.Fatalf("got %.4f", got)
	}
}
