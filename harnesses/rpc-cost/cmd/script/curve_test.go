package main

import (
	"math"
	"testing"
)

// The curve artifact is a second way of answering the same question the
// gauges answer, so the only thing worth testing is that the two agree.
//
// They did not, three times over, and each failure had the same shape: the
// curve interpolated a straight line across something that is not straight.
//
//  1. Allowance ceilings and band edges were sampled, but the handover
//     between two plans happens where their lines CROSS, which is a corner
//     of neither. Chainstack read $83.83 at 10M against a real $49.
//  2. Bisecting on a change of plan id fixed that and missed the dedicated
//     cohort, which steps from $150 to $300 by adding a node while the plan
//     id never changes. GetBlock dedicated read $295 against a real $150.
//  3. Thinning identical points collapsed a flat run to its FIRST point,
//     which deleted the last flat point — the corner where the allowance
//     runs out. Chainstack went straight back to $83.83.
//
// Hence this test, at the three volumes the gauges publish, for every
// provider and every workload. It is the whole reason the browser is allowed
// to interpolate rather than carrying a second pricing engine.
func TestCurveAgreesWithTheModelAtPublishedVolumes(t *testing.T) {
	cat, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Skipf("catalogue not readable from here: %v", err)
	}
	f := BuildCurves(cat)

	// Linear read-off, exactly what the browser does.
	readAt := func(pts []CurvePoint, r float64) (float64, bool) {
		for i := 0; i+1 < len(pts); i++ {
			a, b := pts[i], pts[i+1]
			if a.Requests > r || b.Requests < r {
				continue
			}
			if a.MonthlyUSD == nil || b.MonthlyUSD == nil {
				return 0, false
			}
			if b.Requests == a.Requests {
				return *a.MonthlyUSD, true
			}
			t := (r - a.Requests) / (b.Requests - a.Requests)
			return *a.MonthlyUSD + t*(*b.MonthlyUSD-*a.MonthlyUSD), true
		}
		return 0, false
	}

	checked := 0
	for _, cp := range f.Profiles {
		var pr Profile
		for _, cand := range Profiles {
			if cand.ID == cp.ID {
				pr = cand
			}
		}
		for _, cv := range cp.Providers {
			var prov Provider
			for _, cand := range cat.Providers {
				if cand.Slug == cv.Slug {
					prov = cand
				}
			}
			for _, b := range Buckets {
				want := cheapest(cat, prov, pr, b.Requests, "all")
				got, ok := readAt(cv.Points, b.Requests)
				if !want.Eligible {
					// The curve may legitimately carry no price here; what it
					// must never do is invent one.
					if ok {
						t.Errorf("%s/%s @%s: model says %q, curve quotes $%.2f",
							cv.Slug, cp.ID, b.ID, want.Reason, got)
					}
					continue
				}
				if !ok {
					t.Errorf("%s/%s @%s: model quotes $%.2f, curve has no price",
						cv.Slug, cp.ID, b.ID, want.MonthlyUSD)
					continue
				}
				checked++
				// A cent, or a tenth of a percent on the larger bills, which
				// is the rounding the artifact itself keeps.
				tol := math.Max(0.01, want.MonthlyUSD*0.001)
				if math.Abs(got-want.MonthlyUSD) > tol {
					t.Errorf("%s/%s @%s: model $%.2f, curve $%.2f (off by %.1f%%)",
						cv.Slug, cp.ID, b.ID, want.MonthlyUSD, got,
						math.Abs(got-want.MonthlyUSD)/math.Max(want.MonthlyUSD, 1)*100)
				}
			}
		}
	}
	if checked < 50 {
		t.Fatalf("only %d priced points checked; the cohort should give far more", checked)
	}
	t.Logf("%d priced points agree with the model", checked)
}

// The artifact ships to every reader of the page, so its size is part of its
// contract. It reached 421 MB once, when refinement subdivided a staircase
// all the way down, and 5.6 MB a second time, when it hunted for eligibility
// boundaries inside ranges where nothing was buyable at either end.
func TestCurveStaysSmallEnoughToShip(t *testing.T) {
	cat, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Skipf("catalogue not readable from here: %v", err)
	}
	n := 0
	for _, cp := range BuildCurves(cat).Profiles {
		for _, cv := range cp.Providers {
			n += len(cv.Points)
		}
	}
	if n > 6000 {
		t.Fatalf("%d points: the curve is subdividing something it should not", n)
	}
	t.Logf("%d points across every provider and workload", n)
}

// A gap is not a zero. The board shipped five providers at $0 once because an
// absent reading rendered as a free plan, and the artifact must not give the
// page a way to repeat that.
func TestCurveLeavesGapsNullRatherThanZero(t *testing.T) {
	cat, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Skipf("catalogue not readable from here: %v", err)
	}
	for _, cp := range BuildCurves(cat).Profiles {
		for _, cv := range cp.Providers {
			for _, pt := range cv.Points {
				if pt.MonthlyUSD == nil && pt.Reason == "" {
					t.Errorf("%s/%s @%.0f: no price and no reason", cv.Slug, cp.ID, pt.Requests)
				}
				if pt.MonthlyUSD != nil && pt.Plan == "" {
					t.Errorf("%s/%s @%.0f: a price with no plan behind it", cv.Slug, cp.ID, pt.Requests)
				}
			}
		}
	}
}

// The slider and the gauges are two readings of one bench, so they have to
// agree on who is in the market, not just on the prices. The first emission
// carried all 43 catalogue entries into the curve, including the twelve the
// board drops as not comparable (1RPC, POKT, Lava, Tenderly and the rest),
// which would have put rows on the slider that the ledger beneath it does
// not have.
func TestCurveCarriesTheSameCohortAsTheGauges(t *testing.T) {
	cat, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Skipf("catalogue not readable from here: %v", err)
	}

	// Exactly the two groups priceEverything() refuses to publish.
	want := map[string]bool{}
	for _, p := range cat.Providers {
		if p.Cohort == "excluded" || p.isReference() {
			continue
		}
		want[p.Slug] = true
	}
	if len(want) == 0 {
		t.Fatal("no rankable providers in the catalogue; the test proves nothing")
	}

	for _, cp := range BuildCurves(cat).Profiles {
		got := map[string]bool{}
		for _, cv := range cp.Providers {
			if !want[cv.Slug] {
				t.Errorf("%s: %s is on the slider and not on the board", cp.ID, cv.Slug)
			}
			got[cv.Slug] = true
		}
		// The reverse direction is softer: a provider whose plans cannot
		// serve this profile's chain legitimately emits no points at all.
		for slug := range want {
			if !got[slug] {
				t.Logf("%s: %s has no curve (no plan serves this workload)", cp.ID, slug)
			}
		}
	}
}
