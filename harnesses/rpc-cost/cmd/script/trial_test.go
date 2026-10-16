package main

import "testing"

// A one-month trial is not a monthly price.
//
// Two catalogue entries carry one — QuickNode's "Free trial" (10M credits,
// one month, no card) and NOWNodes' "Start (free trial)" (100k requests, one
// month) — and both are banded `entry` rather than `free`, with a tier_note
// saying so, precisely so they would sit beside what they become ($49 Build,
// EUR 20 Pro). The band was right and the price was not: the model read
// monthly_usd: 0 and quoted it.
//
// Nothing surfaced it while the published volumes were 10M and up, where a
// 10M-credit trial is already past its cap. The cost curve reaches 100k,
// where both trials serve and both would have led the board at $0 — the same
// defect that put five providers above their own leader an hour ago, arriving
// this time through a price that is real but does not recur.
//
// The distinction is recurrence, not the zero. Validation Cloud's Scale is a
// banded pay-as-you-go plan with no subscription and the first 50M CU free:
// at 100k requests it genuinely bills nothing, every month, and it has to
// survive this filter.
func TestATrialIsNotAMonthlyPrice(t *testing.T) {
	c := &Catalogue{FX: FX{EURUSD: 1}}
	pr := Profile{ID: "simple-read", Chain: "ethereum", Mix: map[string]float64{
		"eth_getBalance": 1.0,
	}}

	trialThenPaid := Provider{
		Slug: "quicknode", Cohort: "usage", Currency: "USD", Unit: "credit",
		Weights: map[string]Weights{"ethereum": {Default: f(1)}},
		Plans: []Plan{
			{ID: "free-trial", Tier: TierEntry, MonthlyUSD: f(0), IncludedUnits: f(10e6),
				AllowancePeriod: "month", OverageAllowed: "hard_stop", NonRecurring: true,
				Throughput: Throughput{Unit: "rps", Value: f(15)}, Confidence: "verified"},
			{ID: "build", Tier: TierEntry, MonthlyUSD: f(49), IncludedUnits: f(80e6),
				AllowancePeriod: "month", OverageAllowed: "true", OveragePer1M: f(1),
				Throughput: Throughput{Unit: "rps", Value: f(50)}, Confidence: "verified"},
		},
	}

	// 100k is the curve's floor and well inside the trial's 10M allowance,
	// so this is the volume at which the trial used to win.
	for _, tier := range []string{"all", "", TierEntry} {
		q := cheapest(c, trialThenPaid, pr, 100_000, tier)
		if !q.Eligible {
			t.Fatalf("tier %q: nothing eligible at 100k, the paid plan should be: %+v", tier, q)
		}
		if q.Plan == "free-trial" || q.MonthlyUSD == 0 {
			t.Errorf("tier %q: quoted the one-month trial at $%.2f", tier, q.MonthlyUSD)
		}
		if q.Plan != "build" || q.MonthlyUSD != 49 {
			t.Errorf("tier %q: got %s at $%.2f, want build at $49", tier, q.Plan, q.MonthlyUSD)
		}
	}

	// The guard is recurrence, not the value. A plan that charges nothing
	// every month is an answer, and the fix for one wrong zero must not
	// start hiding the right ones.
	payAsYouGo := Provider{
		Slug: "validation-cloud", Cohort: "usage", Currency: "USD", Unit: "cu",
		Weights: map[string]Weights{"ethereum": {Default: f(1)}},
		Plans: []Plan{
			{ID: "scale", Tier: TierEntry, MonthlyUSD: f(0), IncludedUnits: f(50e6),
				AllowancePeriod: "month", OverageAllowed: "true", OveragePer1M: f(0.5),
				Confidence: "uncertain"},
		},
	}
	q := cheapest(c, payAsYouGo, pr, 100_000, "all")
	if !q.Eligible || q.Plan != "scale" || q.MonthlyUSD != 0 {
		t.Errorf("a recurring $0 plan was dropped with the trials: %+v", q)
	}
}

// Every non-recurring plan in the real catalogue is annotated, so a trial
// added later without the flag is caught here rather than on the page. The
// signal is the catalogue's own prose: these entries already say "not
// recurring" in a tier_note or a note, which is what made the two findable.
func TestEveryTrialInTheCatalogueIsFlagged(t *testing.T) {
	c, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Skipf("catalogue not readable from here: %v", err)
	}
	flagged := 0
	for _, p := range c.Providers {
		for _, pl := range p.Plans {
			if pl.NonRecurring {
				flagged++
				continue
			}
			// A paid-banded plan at $0 is the shape a trial takes: a real
			// free tier is banded `free`, and a recurring pay-as-you-go
			// plan bills on usage rather than ending.
			if pl.MonthlyUSD != nil && *pl.MonthlyUSD == 0 && c.PlanTier(p, pl) != TierFree {
				if pl.OverageAllowed == "hard_stop" {
					t.Errorf("%s/%s: $0, banded paid, and stops at its cap — a trial with no non_recurring flag?", p.Slug, pl.ID)
				}
			}
		}
	}
	// quicknode free-trial and nownodes start are one-month trials; tatum
	// free is a 100k-credit LIFETIME grant, which this test found and I had
	// not, because its allowance stops just short of the curve's floor.
	if flagged != 3 {
		t.Errorf("%d plans flagged non_recurring, expected 3 (quicknode free-trial, nownodes start, tatum free)", flagged)
	}
}
