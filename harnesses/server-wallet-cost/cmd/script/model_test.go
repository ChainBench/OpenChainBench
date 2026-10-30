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

// Bills worked out by hand from the vendors' pages on 2026-10-29. Agents
// medium is 10,000 agents and 500,000 transactions; bot medium is 20
// wallets and 100,000 transactions; payouts large is 100,000 wallets and
// 200,000 transactions.
func TestHandVerifiedBills(t *testing.T) {
	c := loadReal(t)
	cases := []struct {
		slug, scenario string
		x              float64
		want           float64
		plan           string
	}{
		{"coinbase-cdp", "agents", 10000, (1000000 - 5000) * 0.005, "payg"},
		{"thirdweb", "agents", 10000, 99 + 99*1 + 150*0.60 + 250*0.20, "growth"},
		{"circle", "agents", 10000, 4000*0.038 + 5000*0.035, "signing-api"},
		{"magic", "agents", 10000, 99 + 7500*0.04 + 450000*0.005, "startup"},
		{"openfort", "agents", 10000, 599 + 500000*0.004, "scale"},
		{"privy", "agents", 10000, 2000 + 450000*0.01, "payg"},
		{"lit", "agents", 10000, 500000 * 0.01, "credits"},
		{"portal", "agents", 10000, 499 + 499000*0.10 + 9000*0.10, "start-up"},
		// A bot's 20 wallets are inside Circle's free 1,000 at any volume.
		{"circle", "bot", 1000000, 0, "signing-api"},
		{"thirdweb", "bot", 100000, 99 + 99*1, "growth"},
		// Turnkey Pro as a spending floor: 100,000 x $0.05 clears $99.
		{"turnkey", "bot", 100000, 100000 * 0.05, "pro"},
		{"thirdweb", "payouts", 100000, 99 + 99*1 + 100*0.60, "growth"},
		{"circle", "payouts", 100000, 4000*0.038 + 5000*0.035 + 15000*0.03 + 25000*0.026 + 50000*0.023, "signing-api"},
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
		{"turnkey", "agents", 10000, "no published price"},
		// 20 wallets passes Dfns Basic's 10,000, but 100,000 signatures is
		// past Pro's 10,000 a month.
		{"dfns", "bot", 100000, "price is on request"},
		{"crossmint", "agents", 10000, "price is on request"},
		// Openfort Free stops at 2,000 operations: 1,001 transactions.
		{"openfort", "bot", 1001, ""},
	}
	for _, tc := range cases {
		q := cheapest(provider(t, c, tc.slug), scenario(t, c, tc.scenario), tc.x)
		if tc.slug == "openfort" {
			if !q.Eligible || q.Plan == "free" {
				t.Errorf("openfort bot @1001: %+v, want a paid plan past the free stop", q)
			}
			continue
		}
		if q.Eligible {
			t.Errorf("%s %s @%v: priced at $%.2f, want not eligible", tc.slug, tc.scenario, tc.x, q.MonthlyUSD)
			continue
		}
		if !strings.Contains(q.Reason, tc.mention) {
			t.Errorf("%s: reason %q does not say %q", tc.slug, q.Reason, tc.mention)
		}
	}
	// Dfns prices from its annual fee. A bot at 1,000 transactions holds 20
	// wallets, past Starter's 10, and signs 1,000 times, exactly Basic's
	// allowance: Basic, $8,000 / 12.
	q := cheapest(provider(t, c, "dfns"), scenario(t, c, "bot"), 1000)
	if !q.Eligible || q.Plan != "basic" || math.Abs(q.MonthlyUSD-roundCents(8000.0/12)) > 1e-9 {
		t.Errorf("dfns bot @1000: got %+v, want basic at $666.67", q)
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

// Turnkey Pro's charges reach its $99 floor at 1,980 signatures, which on
// the bot scenario is 1,980 transactions. The curve needs a point there.
func TestCurveHasMinimumKink(t *testing.T) {
	c := loadReal(t)
	for _, cs := range BuildCurves(c).Scenarios {
		if cs.ID != "bot" {
			continue
		}
		for _, prov := range cs.Providers {
			if prov.Slug != "turnkey" {
				continue
			}
			for _, pt := range prov.Points {
				if math.Abs(pt.MAU-1980) < 1e-6 {
					return
				}
			}
			t.Fatalf("no curve point at the 1,980-transaction kink")
		}
	}
	t.Fatalf("turnkey bot curve missing")
}

// Payouts at 10,000 wallets: Privy's $0 is an "at least" figure (its $1M
// volume clause has no published rate) under every price that holds, so it
// is published but not ranked. Where a floor price is not the cheapest
// (Privy on agents at 10,000), it stays ranked.
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
	if got := at("payouts", 10000); !got["privy"] || len(got) != 1 {
		t.Errorf("payouts@10k: floors that would lead = %v, want only privy", got)
	}
	if got := at("agents", 10000); len(got) != 0 {
		t.Errorf("agents@10k: floors that would lead = %v, want none", got)
	}
}
