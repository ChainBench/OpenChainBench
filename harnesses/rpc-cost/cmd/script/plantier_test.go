package main

import (
	"math"
	"testing"
)

// Provider plan names do not line up across the cohort, so the tier is a
// price band. Chainstack "Growth" at $49 and Helius "Business" at $499
// must not land in the same bucket just because of what they are called.
func TestPlanTierIsAPriceBandNotAName(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1.1355}}
	p := Provider{Currency: "USD"}
	band := func(usd float64) string {
		return c.PlanTier(p, Plan{MonthlyUSD: &usd})
	}
	for _, tc := range []struct {
		usd  float64
		want string
	}{
		{0, TierFree},
		{49, TierEntry}, // Chainstack calls this "Growth"
		{50, TierEntry},
		{199, TierGrowth},
		{499, TierBusiness}, // Helius calls this "Business"
		{999, TierBusiness},
		{2999, TierEnterprise},
	} {
		if got := band(tc.usd); got != tc.want {
			t.Errorf("$%.0f/mo -> %s, want %s", tc.usd, got, tc.want)
		}
	}

	// An explicit tier always wins: a $0 30-day trial is not a free tier.
	zero := 0.0
	if got := c.PlanTier(p, Plan{MonthlyUSD: &zero, Tier: TierEntry}); got != TierEntry {
		t.Errorf("explicit tier ignored, got %s", got)
	}
	// A sales-gated plan with no published price is enterprise, not free.
	if got := c.PlanTier(p, Plan{}); got != TierEnterprise {
		t.Errorf("unpriced plan -> %s, want %s", got, TierEnterprise)
	}
	// EUR bands convert before comparing, or NOWNodes would be misbanded.
	eur := 45.0 // = $51.10, just over the entry ceiling
	if got := c.PlanTier(Provider{Currency: "EUR"}, Plan{MonthlyUSD: &eur}); got != TierGrowth {
		t.Errorf("EUR 45 (= $51.10) -> %s, want %s", got, TierGrowth)
	}
}

// Free tiers all cost $0, so they can only be ranked on what the
// allowance buys — which means dividing by the weight of the actual
// workload. "200M credits" is not comparable to "30M CU" until it is.
func TestFreeAllowanceConvertsUnitsToRequests(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}

	// Ankr: 200M credits/month at 200 credits per EVM call = 1M requests.
	units := 200e6
	ankr := Provider{
		Slug: "ankr", Weights: map[string]Weights{"ethereum": {Default: f(200)}},
		Plans: []Plan{{ID: "freemium", Tier: TierFree, IncludedUnits: &units, AllowancePeriod: "month"}},
	}
	got, _, ok := c.FreeAllowanceRequests(ankr, pr)
	if !ok || math.Abs(got-1e6) > 1 {
		t.Errorf("ankr free = %v (%v), want 1e6", got, ok)
	}

	// GetBlock's free tier is per DAY, so it must be multiplied out to a
	// month rather than read as a monthly figure.
	daily := 50e3
	gb := Provider{
		Slug: "getblock", Weights: map[string]Weights{"ethereum": {Default: f(20)}},
		Plans: []Plan{{ID: "free", Tier: TierFree, IncludedUnits: &daily, AllowancePeriod: "day"}},
	}
	got, _, ok = c.FreeAllowanceRequests(gb, pr)
	if !ok || math.Abs(got-75e3) > 1 { // 50k * 30 days / 20 CU
		t.Errorf("getblock free = %v (%v), want 75000", got, ok)
	}

	// A provider with no free plan reports absence, not zero — a zero
	// would rank it as the worst free tier rather than as having none.
	if _, _, ok := c.FreeAllowanceRequests(Provider{Slug: "triton"}, pr); ok {
		t.Error("provider without a free plan must report ok=false")
	}
}

// The tier filter must actually restrict the search, otherwise "cheapest
// entry plan" silently returns an enterprise plan.
func TestCheapestRespectsTierFilter(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{"eth_getBalance": 1}}
	entry, ent := 49.0, 990.0
	small, big := 20e6, 400e6
	over := 20.0
	p := Provider{
		Slug: "chainstack", Cohort: "usage", Currency: "USD",
		Weights: map[string]Weights{"ethereum": {Default: f(1)}},
		Plans: []Plan{
			{ID: "growth", MonthlyUSD: &entry, IncludedUnits: &small, AllowancePeriod: "month", OveragePer1M: &over, OverageAllowed: "true", Archive: "true"},
			{ID: "enterprise", MonthlyUSD: &ent, IncludedUnits: &big, AllowancePeriod: "month", OveragePer1M: &over, OverageAllowed: "true", Archive: "true"},
		},
	}
	// Unrestricted at 300M: enterprise wins on price.
	if q := cheapest(c, p, pr, 300e6, ""); q.Plan != "enterprise" {
		t.Errorf("unrestricted picked %q, want enterprise", q.Plan)
	}
	// Restricted to the entry band: must stay on growth even though the
	// bill is higher. That is the whole point of the tier axis.
	if q := cheapest(c, p, pr, 300e6, TierEntry); q.Plan != "growth" {
		t.Errorf("entry-tier picked %q, want growth", q.Plan)
	}
	// A tier the provider does not sell yields a reason, not a zero price.
	if q := cheapest(c, p, pr, 10e6, TierFree); q.Eligible || q.Reason == "" {
		t.Errorf("absent tier must be ineligible with a reason, got %+v", q)
	}
}
