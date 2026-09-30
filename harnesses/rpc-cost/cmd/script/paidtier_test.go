package main

import "testing"

// Reproduces Syndica exactly: the "paid" view dropped its 1,000M cell
// while "all" and "enterprise" both kept it, which is impossible if
// "paid" is really "all minus free".
func TestPaidTierKeepsEveryNonFreePlan(t *testing.T) {
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

	all := cheapest(c, p, pr, 1000e6, "")
	ent := cheapest(c, p, pr, 1000e6, TierEnterprise)
	paid := cheapest(c, p, pr, 1000e6, "paid")

	if !all.Eligible || all.Plan != "calc-1000m" {
		t.Fatalf("all: %+v", all)
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
		t.Errorf("paid = %s at $%.2f, want calc-1000m at $1362", paid.Plan, paid.MonthlyUSD)
	}
}
