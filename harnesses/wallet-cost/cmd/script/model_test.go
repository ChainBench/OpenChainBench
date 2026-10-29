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

func profile(t *testing.T, c *Catalogue, id string) Profile {
	t.Helper()
	pr, ok := c.Profile(id)
	if !ok {
		t.Fatalf("no profile %s", id)
	}
	return pr
}

// Bills worked out by hand from the vendors' pages on 2026-10-29, written
// as the arithmetic so a reader can check them without running anything.
func TestHandVerifiedBills(t *testing.T) {
	c := loadReal(t)
	cases := []struct {
		slug, profile string
		mau           float64
		want          float64
		plan          string
	}{
		// Dynamic Growth: $249 includes 5,000 MAU, then $0.005.
		{"dynamic", "consumer", 10000, 249 + 5000*0.005, "growth"},
		{"dynamic", "trading", 100000, 249 + 95000*0.005, "growth"},
		// Circle, graduated band by band from 1,001.
		{"circle", "consumer", 100000, 4000*0.05 + 5000*0.047 + 15000*0.04 + 25000*0.035 + 50000*0.03, "all-included"},
		// Privy at exactly 10,000 MAU and 50,000 signatures is still Scale:
		// pay-as-you-go starts when usage EXCEEDS those.
		{"privy", "consumer", 10000, 499, "scale"},
		// 100 signatures a user is 100,000 signatures at 1,000 users, which
		// pushes Privy into pay-as-you-go whatever the MAU.
		{"privy", "trading", 1000, 2000 + 50000*0.01, "payg"},
		// Turnkey Pro as a spending floor: 5,000 signatures x $0.05 = $250
		// clears the $99 minimum; Pay as You Go would be 4,975 x $0.10.
		{"turnkey", "consumer", 1000, 5000 * 0.05, "pro"},
		// Web3Auth Growth with overage beats Scale at 10,000.
		{"web3auth", "consumer", 10000, 69 + 7000*0.045, "growth"},
		// CDP: 2,000 new wallets x 1 + 50,000 transactions x 2 operations.
		{"coinbase-cdp", "consumer", 10000, (2000 + 100000 - 5000) * 0.005, "payg"},
		// Openfort Pro: same 102,000 operations, 100,000 included.
		{"openfort", "consumer", 10000, 249 + 2000*0.006, "pro"},
		// Reown Growth overtakes Pro above 15,000.
		{"reown", "consumer", 100000, 350 + 85000*0.05, "growth"},
		// thirdweb: first 1,000 free, then $0.015.
		{"thirdweb", "consumer", 100000, 99 + 99000*0.015, "growth"},
		// Magic Startup: 2,500 MAW and 50,000 signatures included.
		{"magic", "trading", 10000, 99 + 7500*0.04 + 950000*0.005, "startup"},
	}
	for _, tc := range cases {
		q := cheapest(provider(t, c, tc.slug), profile(t, c, tc.profile), tc.mau)
		if !q.Eligible {
			t.Errorf("%s %s @%v: not eligible (%s)", tc.slug, tc.profile, tc.mau, q.Reason)
			continue
		}
		if math.Abs(q.MonthlyUSD-roundCents(tc.want)) > 1e-9 || q.Plan != tc.plan {
			t.Errorf("%s %s @%v: got $%.2f on %s, want $%.2f on %s", tc.slug, tc.profile, tc.mau, q.MonthlyUSD, q.Plan, tc.want, tc.plan)
		}
	}
}

func TestIneligibleCarriesReason(t *testing.T) {
	c := loadReal(t)
	cases := []struct {
		slug, profile string
		mau           float64
		mention       string
	}{
		// 10,000 users is 10,000 wallets, past Pro's 2K: Enterprise only.
		{"turnkey", "consumer", 10000, "no published price"},
		// 50,000 transactions x 30 credits = 1.5M credits, past Scale's 1M.
		{"zerodev", "consumer", 10000, "price is on request"},
		// 5,000 transactions, past the free 2,000.
		{"crossmint", "consumer", 1000, "price is on request"},
		// Reown's own page sends exchanges to a custom plan, at any size.
		{"reown", "trading", 1000, "custom plan"},
	}
	for _, tc := range cases {
		q := cheapest(provider(t, c, tc.slug), profile(t, c, tc.profile), tc.mau)
		if q.Eligible {
			t.Errorf("%s %s @%v: priced at $%.2f, want not eligible", tc.slug, tc.profile, tc.mau, q.MonthlyUSD)
			continue
		}
		if !strings.Contains(q.Reason, tc.mention) {
			t.Errorf("%s: reason %q does not say %q", tc.slug, q.Reason, tc.mention)
		}
	}
}

// A boundary is inclusive and float drift must not push an exact fit over
// it: Para's free plan serves exactly 1,200 users.
func TestCapIsInclusiveAndDriftTolerant(t *testing.T) {
	c := loadReal(t)
	para := provider(t, c, "getpara")
	pr := profile(t, c, "consumer")
	if q := cheapest(para, pr, 1200); !q.Eligible || q.MonthlyUSD != 0 {
		t.Fatalf("1,200 users: got %+v, want free", q)
	}
	if q := cheapest(para, pr, 1200*(1+1e-13)); q.MonthlyUSD != 0 {
		t.Fatalf("float drift above 1,200 left the free plan: %+v", q)
	}
	if q := cheapest(para, pr, 1201); q.MonthlyUSD == 0 {
		t.Fatalf("1,201 users still free")
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
	for _, cp := range curves.Profiles {
		for _, prov := range cp.Providers {
			p := provider(t, c, prov.Slug)
			pts := prov.Points
			for i := 1; i < len(pts); i++ {
				if pts[i].MAU <= pts[i-1].MAU {
					t.Fatalf("%s %s: points not increasing at %d", cp.ID, prov.Slug, i)
				}
			}
			for k := 0; k <= 4000; k++ {
				x := math.Exp(math.Log(c.CurveFloor) + float64(k)/4000*(math.Log(c.CurveCeiling)-math.Log(c.CurveFloor)))
				want := cheapest(p, cp.Profile, x)
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

// Turnkey Pro's charges reach its $99 floor at 1,980 signatures, which is
// 396 users at 5 a user. The curve needs a point there or the line from
// the floor to the next corner cuts the kink.
func TestCurveHasMinimumKink(t *testing.T) {
	c := loadReal(t)
	for _, cp := range BuildCurves(c).Profiles {
		if cp.ID != "consumer" {
			continue
		}
		for _, prov := range cp.Providers {
			if prov.Slug != "turnkey" {
				continue
			}
			for _, pt := range prov.Points {
				if math.Abs(pt.MAU-396) < 1e-6 {
					return
				}
			}
			t.Fatalf("no curve point at the 396-user kink")
		}
	}
	t.Fatalf("turnkey consumer curve missing")
}
