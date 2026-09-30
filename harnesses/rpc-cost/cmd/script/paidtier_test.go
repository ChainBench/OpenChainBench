package main

import "testing"

// `all` is the default view and means "cheapest paid plan". It must keep
// every non-free plan: reproducing Syndica, whose 1,000M cell once
// vanished from that view while the enterprise filter kept it, which is
// impossible when one is a superset of the other.
func TestDefaultViewKeepsEveryNonFreePlan(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "solana-bot", Chain: "solana", Mix: map[string]float64{
		"getAccountInfo": 0.40, "getMultipleAccounts": 0.20, "getLatestBlockhash": 0.15,
		"sendTransaction": 0.15, "simulateTransaction": 0.10,
	}}
	p := Provider{
		Slug: "syndica", Cohort: "usage", Currency: "USD", Unit: "request",
		Weights: map[string]Weights{"solana": {Default: f(1)}},
		Plans: []Plan{
			{ID: "free", Tier: TierFree, MonthlyUSD: f(0), IncludedUnits: f(10e6),
				AllowancePeriod: "month", OverageAllowed: "hard_stop",
				Throughput: Throughput{Unit: "rps", Value: f(100)}, Confidence: "uncertain"},
			{ID: "calc-200m", Tier: TierGrowth, MonthlyUSD: f(199), IncludedUnits: f(200e6),
				AllowancePeriod: "month", OverageAllowed: "hard_stop", MaxUnits: f(10000e6),
				Throughput: Throughput{Unit: "rps", Value: f(300)}, Confidence: "verified"},
			{ID: "calc-1000m", Tier: TierEnterprise, MonthlyUSD: f(1362), IncludedUnits: f(1000e6),
				AllowancePeriod: "month", OverageAllowed: "hard_stop", MaxUnits: f(10000e6),
				Throughput: Throughput{Unit: "rps", Value: f(400)}, Confidence: "verified"},
			{ID: "hyperscale", Tier: TierEnterprise, Confidence: "unpublished"},
		},
	}

	unrestricted := cheapest(c, p, pr, 1000e6, "")
	ent := cheapest(c, p, pr, 1000e6, TierEnterprise)
	paid := cheapest(c, p, pr, 1000e6, "all")

	if !unrestricted.Eligible || unrestricted.Plan != "calc-1000m" {
		t.Fatalf("unrestricted: %+v", unrestricted)
	}
	if !ent.Eligible || ent.Plan != "calc-1000m" {
		t.Fatalf("enterprise: %+v", ent)
	}
	// enterprise is a subset of paid, so paid cannot be empty when
	// enterprise is not.
	if !paid.Eligible {
		t.Errorf("paid dropped a plan that the enterprise filter kept: %+v", paid)
	}
	if paid.Plan != "calc-1000m" || paid.MonthlyUSD != 1362 {
		t.Errorf("default view = %s at $%.2f, want calc-1000m at $1362", paid.Plan, paid.MonthlyUSD)
	}

	// And at a volume the free tier CAN serve, the default view must still
	// price the cheapest paid plan rather than handing the cell to $0.
	small := cheapest(c, p, pr, 5e6, "all")
	if small.Plan == "free" || small.MonthlyUSD == 0 {
		t.Errorf("default view took the free tier at 5M: %+v", small)
	}
	if free := cheapest(c, p, pr, 5e6, TierFree); !free.Eligible || free.MonthlyUSD != 0 {
		t.Errorf("the free tab must still show the free tier at 5M: %+v", free)
	}
}
