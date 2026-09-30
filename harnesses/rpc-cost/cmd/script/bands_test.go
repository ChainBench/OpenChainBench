package main

import (
	"math"
	"testing"
)

func f(v float64) *float64 { return &v }

// Sliding bands get cheaper with volume. Charging the first band's rate
// at every volume overstates a banded provider's bill by 30%+ at the top
// bucket — it put Validation Cloud at $19,975 instead of $14,057.50.
func TestOverageBandsAreMarginal(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{Slug: "validation-cloud", Currency: "USD"}
	// Validation Cloud: 0-50M free, 50-150M $0.50, 150-500M $0.45,
	// 500M-1B $0.40, above $0.35 per 1M CU.
	pl := Plan{
		IncludedUnits: f(50e6),
		OverageBands: []OverageBand{
			{UpToUnits: f(150e6), PricePer1M: 0.50},
			{UpToUnits: f(500e6), PricePer1M: 0.45},
			{UpToUnits: f(1000e6), PricePer1M: 0.40},
			{UpToUnits: nil, PricePer1M: 0.35},
		},
	}

	// Entirely inside the free allowance.
	if got := c.overageCost(p, pl, 50e6, 40e6); got != 0 {
		t.Errorf("below allowance = %v, want 0", got)
	}
	// Inside the first paid band only: 50M units at $0.50.
	if got := c.overageCost(p, pl, 50e6, 100e6); math.Abs(got-25) > 1e-9 {
		t.Errorf("first band = %v, want 25", got)
	}
	// Spanning three bands: 100M@0.50 + 350M@0.45 + 100M@0.40 = 50+157.5+40.
	if got := c.overageCost(p, pl, 50e6, 600e6); math.Abs(got-247.5) > 1e-9 {
		t.Errorf("three bands = %v, want 247.5", got)
	}
	// Past the last ceiling: the open-ended band keeps charging rather
	// than letting the excess through free.
	// 100@0.50 + 350@0.45 + 500@0.40 + 1000@0.35 = 50+157.5+200+350.
	if got := c.overageCost(p, pl, 50e6, 2000e6); math.Abs(got-757.5) > 1e-9 {
		t.Errorf("open band = %v, want 757.5", got)
	}
}

// A flat rate must keep working — it is the single-band case and most of
// the cohort uses it.
func TestFlatOverageUnchangedByBandSupport(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	p := Provider{Slug: "helius", Currency: "USD"}
	pl := Plan{IncludedUnits: f(10e6), OveragePer1M: f(5.0)}
	if got := c.overageCost(p, pl, 10e6, 30e6); math.Abs(got-100) > 1e-9 {
		t.Errorf("flat overage = %v, want 100", got)
	}
}

// Beyond a published ceiling a plan is unavailable, not expensive.
func TestMaxUnitsMakesPlanIneligible(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}
	p := Provider{
		Slug: "tatum", Cohort: "usage", Currency: "USD", Unit: "credit",
		Weights: map[string]Weights{"ethereum": {Default: f(2)}},
	}
	pl := Plan{
		ID: "scale", MonthlyUSD: f(999), IncludedUnits: f(400e6), MaxUnits: f(400e6),
		AllowancePeriod: "month", OveragePer1M: f(9), OverageAllowed: "true",
		Archive: "true", Confidence: "verified",
	}
	// 100M requests x 2 credits = 200M, inside the ceiling.
	if q := quote(c, p, pl, pr, 100e6); !q.Eligible {
		t.Errorf("inside ceiling should be eligible, got %q", q.Reason)
	}
	// 1000M requests x 2 credits = 2,000M, well past it.
	q := quote(c, p, pl, pr, 1000e6)
	if q.Eligible {
		t.Error("past the published ceiling the plan must be ineligible, not metered")
	}
	if q.Reason == "" {
		t.Error("ceiling rejection must carry a reason")
	}
}

// An add-on is only reachable on top of the plan it requires, and the
// bill is both. Infura's $200 extra-credits add-on cannot be bought on
// the free tier, so its real entry cost is Developer $50 + $200 = $250 —
// which loses to Team's $225 on arithmetic. That matters because the
// add-on's allowance period is ambiguous by a factor of 30: pricing the
// prerequisite makes the unresolved figure stop deciding the answer,
// which is better than excluding it by fiat.
func TestRequiredPlanIsAddedToTheBill(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}
	p := Provider{
		Slug: "infura", Cohort: "usage", Currency: "USD", Unit: "credit",
		Weights: map[string]Weights{"ethereum": {Default: f(80)}},
		Plans: []Plan{
			{ID: "developer", Tier: TierEntry, MonthlyUSD: f(50), IncludedUnits: f(15e6),
				AllowancePeriod: "day", OverageAllowed: "hard_stop", Archive: "true", Confidence: "verified"},
			{ID: "team", Tier: TierGrowth, MonthlyUSD: f(225), IncludedUnits: f(75e6),
				AllowancePeriod: "day", OverageAllowed: "hard_stop", Archive: "true", Confidence: "verified"},
			{ID: "extra-credits-addon", Tier: TierGrowth, MonthlyUSD: f(200), IncludedUnits: f(55e6),
				AllowancePeriod: "day", OverageAllowed: "hard_stop", Archive: "true", Confidence: "uncertain",
				RequiresPlan: "developer"},
		},
	}
	// 10M requests x 80 credits = 800M/month = 26.7M/day. Developer's
	// 15M/day cannot serve it; Team's 75M/day and the add-on's 55M/day can.
	q := cheapest(c, p, pr, 10e6, "")
	if q.Plan != "team" {
		t.Errorf("cheapest picked %q at $%.2f, want team at $225: the add-on is $200 + its $50 prerequisite", q.Plan, q.MonthlyUSD)
	}
	if q.MonthlyUSD != 225 {
		t.Errorf("team = $%.2f, want $225", q.MonthlyUSD)
	}
	// And the add-on itself must be quoted at the full $250, not $200.
	addon := quote(c, p, p.Plans[2], pr, 10e6)
	if !addon.Eligible || addon.MonthlyUSD != 250 {
		t.Errorf("add-on = $%.2f (eligible %v), want $250: its price plus the plan it requires", addon.MonthlyUSD, addon.Eligible)
	}
	// A plan carrying an unresolved caveat is still ranked — excluding
	// them wholesale removed a quarter of the cohort, PublicNode included.
	if addon.Confidence != "uncertain" {
		t.Errorf("confidence should be carried through for the page to badge, got %q", addon.Confidence)
	}
}
