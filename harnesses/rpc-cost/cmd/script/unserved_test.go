package main

import "testing"

// Dwellir's Free plan excludes eth_getLogs while its paid plans serve it,
// and the weights table is per provider, so only the plan can say it. A
// workload that calls eth_getLogs must be unavailable on Free, both on the
// cost board and in the free allowance, and still priced on Developer.
func TestUnservedMethodsArePerPlan(t *testing.T) {
	c, err := LoadCatalogue("../../pricing/catalogue.yml")
	if err != nil {
		t.Fatal(err)
	}
	var p Provider
	for _, x := range c.Providers {
		if x.Slug == "dwellir" {
			p = x
		}
	}
	if p.Slug == "" {
		t.Fatal("dwellir missing from the catalogue")
	}
	plan := func(id string) Plan {
		for _, pl := range p.Plans {
			if pl.ID == id {
				return pl
			}
		}
		t.Fatalf("dwellir has no plan %q", id)
		return Plan{}
	}
	var dapp, simple Profile
	for _, pr := range Profiles {
		switch pr.ID {
		case "dapp":
			dapp = pr
		case "simple-read":
			simple = pr
		}
	}

	q := quote(c, p, plan("free"), dapp, 1e6)
	if q.Eligible || q.Reason != "plan does not serve eth_getLogs" {
		t.Errorf("free dapp: eligible=%v reason=%q, want refused on eth_getLogs", q.Eligible, q.Reason)
	}
	if q := quote(c, p, plan("developer"), dapp, 1e6); !q.Eligible {
		t.Errorf("developer dapp should be priced, got %q", q.Reason)
	}
	if _, _, ok := c.FreeAllowanceRequests(p, dapp); ok {
		t.Error("the free allowance must not count a workload the free plan refuses")
	}
	// 100,000 a day is a daily cap, so the month is 30 days of it.
	got, _, ok := c.FreeAllowanceRequests(p, simple)
	if !ok || got != 100000*daysPerMonth {
		t.Errorf("free simple reads = %v %v, want %v", got, ok, 100000*daysPerMonth)
	}
}
