package main

import (
	"math"
	"strings"
	"testing"
)

func loadReal(t *testing.T) *Catalogue {
	t.Helper()
	c, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Fatalf("committed catalogue does not load: %v", err)
	}
	return c
}

func provider(t *testing.T, c *Catalogue, slug string) Provider {
	t.Helper()
	for _, p := range c.Providers {
		if p.Slug == slug {
			return p
		}
	}
	t.Fatalf("no provider %s", slug)
	return Provider{}
}

func scenario(t *testing.T, c *Catalogue, id string) Scenario {
	t.Helper()
	s, ok := c.Scenario(id)
	if !ok {
		t.Fatalf("no scenario %s", id)
	}
	return s
}

// Bills worked out by hand from the vendors' pages on 2026-10-30, gas
// excluded. Gas per sponsored operation: Base $0.0020, Arbitrum $0.0072,
// Ethereum $0.150, so 100,000 operations burn $200, $720 and $15,000.
func TestHandVerifiedBills(t *testing.T) {
	c := loadReal(t)
	cases := []struct {
		slug, scenario string
		x              float64
		want           float64
		plan           string
	}{
		// 1,050 credits an operation past 10M included, $1 per 100,000; 10%.
		{"pimlico", "base", 100000, (105000000-10000000)/100000.0 + 0.10*200, "payg"},
		{"pimlico", "ethereum", 10000, (10500000-10000000)/100000.0 + 0.10*1500, "payg"},
		// 3,520 CU at $0.52 a million, 8%.
		{"alchemy", "arbitrum", 100000, 352 * 0.52 + 0.08*720, "payg"},
		// 200,000 credits is past Launch's 100,000: Scale.
		{"zerodev", "base", 10000, 399 + 0.08*20, "scale"},
		{"zerodev", "base", 5000, 69 + 0.08*10, "launch"},
		{"thirdweb", "ethereum", 100000, 99 + 99*1 + 0.025*15000, "growth"},
		{"thirdweb", "base", 1000000, 99 + 99*1 + 150*0.60 + 750*0.20 + 0.025*2000, "growth"},
		// 50M billing units, 10M free, $0.50 a million; 7%.
		{"coinbase-cdp", "base", 100000, 40*0.50 + 0.07*200, "payg"},
		{"circle", "ethereum", 100000, 0.05 * 15000, "gas-station"},
		{"candide", "base", 10000, 333 + 5000*0.01, "launch"},
		{"candide", "arbitrum", 100000, 749 + 75000*0.005, "grow"},
		{"etherspot", "ethereum", 100000, 100000 * 1625 / 250000.0, "payg"},
		{"openfort", "base", 100000, 249 + 0.05*200, "pro"},
		{"openfort", "base", 2000, 0.10 * 4, "free"},
	}
	for _, tc := range cases {
		q := cheapest(provider(t, c, tc.slug), scenario(t, c, tc.scenario), tc.x)
		if !q.Eligible {
			t.Errorf("%s %s @%v: not eligible (%s)", tc.slug, tc.scenario, tc.x, q.Reason)
			continue
		}
		if math.Abs(q.MonthlyUSD-roundCents(tc.want)) > 1e-9 || q.Plan != tc.plan {
			t.Errorf("%s %s @%v: got $%.2f on %s, want $%.2f on %s", tc.slug, tc.scenario, tc.x, q.MonthlyUSD, q.Plan, tc.want, tc.plan)
		}
	}
}

func TestQuotesAndCaps(t *testing.T) {
	c := loadReal(t)
	cases := []struct {
		slug, scenario string
		x              float64
		mention        string
	}{
		// 1,000,000 credits is 50,000 operations; overage is not published.
		{"zerodev", "base", 100000, "no published price"},
		{"candide", "base", 1000000, "no published price"},
		{"coinbase-cdp", "arbitrum", 10000, "Base only"},
		{"coinbase-cdp", "ethereum", 10000, "Base only"},
	}
	for _, tc := range cases {
		q := cheapest(provider(t, c, tc.slug), scenario(t, c, tc.scenario), tc.x)
		if q.Eligible {
			t.Errorf("%s %s @%v: priced at $%.2f, want not eligible", tc.slug, tc.scenario, tc.x, q.MonthlyUSD)
			continue
		}
		if !strings.Contains(q.Reason, tc.mention) {
			t.Errorf("%s: reason %q does not say %q", tc.slug, q.Reason, tc.mention)
		}
	}
	// Openfort Free stops at 2,000 operations: 2,001 moves to a paid plan.
	if q := cheapest(provider(t, c, "openfort"), scenario(t, c, "base"), 2001); !q.Eligible || q.Plan == "free" {
		t.Errorf("openfort base @2001: %+v, want a paid plan past the free stop", q)
	}
}

func TestGraduated(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	tiers := []Tier{{UpTo: f(10), Rate: f(0)}, {UpTo: f(20), Rate: f(1)}, {Rate: f(0.5)}}
	for _, tc := range []struct{ q, want float64 }{{0, 0}, {10, 0}, {15, 5}, {20, 10}, {30, 15}} {
		if got := graduated(tc.q, tiers); math.Abs(got-tc.want) > 1e-12 {
			t.Errorf("graduated(%v) = %v, want %v", tc.q, got, tc.want)
		}
	}
}

// The curve must reproduce the model at any MAU by linear interpolation,
// which is what the browser does. A missing corner shows up here as a
// mismatch between two of its points.
func TestCurveInterpolatesExactly(t *testing.T) {
	c := loadReal(t)
	curves := BuildCurves(c)
	for _, cp := range curves.Scenarios {
		for _, prov := range cp.Providers {
			p := provider(t, c, prov.Slug)
			pts := prov.Points
			for i := 1; i < len(pts); i++ {
				if pts[i].MAU <= pts[i-1].MAU {
					t.Fatalf("%s %s: points not increasing at %d", cp.ID, prov.Slug, i)
				}
			}
			for k := 0; k <= 4000; k++ {
				x := math.Exp(math.Log(cp.Floor) + float64(k)/4000*(math.Log(cp.Ceiling)-math.Log(cp.Floor)))
				want := cheapest(p, cp.Scenario, x)
				got, gap, ok := interpolate(pts, x)
				if !ok {
					continue // inside a jump segment
				}
				if gap != !want.Eligible {
					t.Fatalf("%s %s @%.3f: curve gap=%v, model eligible=%v", cp.ID, prov.Slug, x, gap, want.Eligible)
				}
				if want.Eligible && math.Abs(got-want.MonthlyUSD) > 0.01+1e-9 {
					t.Fatalf("%s %s @%.3f: curve $%.4f, model $%.2f", cp.ID, prov.Slug, x, got, want.MonthlyUSD)
				}
			}
		}
	}
}

func interpolate(pts []CurvePoint, x float64) (v float64, gap bool, ok bool) {
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		if x < a.MAU || x > b.MAU {
			continue
		}
		switch {
		case a.USD == nil && b.USD == nil:
			return 0, true, true
		case a.USD == nil || b.USD == nil:
			return 0, false, false
		}
		t := (x - a.MAU) / (b.MAU - a.MAU)
		return *a.USD + t*(*b.USD-*a.USD), false, true
	}
	return 0, false, false
}

// Pimlico's 10,000,000 included credits run out at 9,523.8 sponsored
// operations (1,050 each). The curve needs a point there.
func TestCurveHasIncludedKink(t *testing.T) {
	c := loadReal(t)
	for _, cs := range BuildCurves(c).Scenarios {
		for _, prov := range cs.Providers {
			if prov.Slug != "pimlico" {
				continue
			}
			found := false
			for _, pt := range prov.Points {
				if math.Abs(pt.MAU-10000000.0/1050) < 1e-6 {
					found = true
				}
			}
			if !found {
				t.Fatalf("%s: no pimlico curve point at the included-credit kink", cs.ID)
			}
		}
	}
}

// Base at 100,000 operations: Circle's 5% is an "at least" figure (its
// per-wallet fee is not counted) under CDP's price, which holds, so it is
// published but not ranked. On Ethereum it is not the cheapest and stays
// ranked.
func TestFloorsThatWouldLead(t *testing.T) {
	cat := loadReal(t)
	at := func(scenario string, x float64) map[string]bool {
		var s Scenario
		for _, v := range cat.Scenarios {
			if v.ID == scenario {
				s = v
			}
		}
		qs := map[string]Quote{}
		for _, p := range cat.Ranked() {
			qs[p.Slug] = cheapest(p, s, x)
		}
		return floorsThatWouldLead(qs)
	}
	if got := at("base", 100000); !got["circle"] || len(got) != 1 {
		t.Errorf("base@100k: floors that would lead = %v, want only circle", got)
	}
	if got := at("ethereum", 100000); len(got) != 0 {
		t.Errorf("ethereum@100k: floors that would lead = %v, want none", got)
	}
}
