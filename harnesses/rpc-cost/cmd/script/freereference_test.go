package main

import "testing"

// A reference row publishes no free allowance.
//
// The bench ranks plans on the one axis that separates them, so the
// allowance IS the ranking and a row the catalogue refuses to rank has
// nothing to show. Solana Foundation is the case this exists for: its
// 25.92M is 10 requests/second integrated over 30 days, which its own
// entry calls DERIVED rather than published, on an endpoint Solana's docs
// call "not intended for production applications". It was ranked first on
// the Solana tab at more than double OnFinality, above eleven plans with
// published allowances and a commercial relationship behind them, while
// the methodology printed under the table said keyless public endpoints
// with no published allowance are excluded.
func TestReferenceRowPublishesNoFreeAllowance(t *testing.T) {
	c := realCatalogue(t)
	seen := 0
	for _, p := range c.Providers {
		if !p.isReference() {
			continue
		}
		seen++
		for _, pr := range Profiles {
			if reqs, planID, ok := c.FreeAllowanceRequests(p, pr); ok {
				t.Errorf("%s is a reference row and still publishes %.0f requests for %s (plan %s)",
					p.Slug, reqs, pr.ID, planID)
			}
		}
		if len(c.FreeEnvelopes(p)) != 0 {
			t.Errorf("%s is a reference row and still reports an envelope", p.Slug)
		}
	}
	if seen == 0 {
		t.Fatal("no reference row in the catalogue; this test would pass vacuously")
	}
	t.Logf("%d reference rows checked", seen)
}

// An allowance the catalogue calls derived must not be ranked. This is the
// rule behind the test above, stated on the data rather than on the flag:
// if a free plan's note says the figure was computed from a rate limit
// instead of read off a page, the row has to be a reference row, because
// ranking a throughput ceiling against published allowances compares a
// theoretical maximum with a contractual one.
func TestDerivedAllowanceIsNeverRanked(t *testing.T) {
	c := realCatalogue(t)
	for _, p := range c.Providers {
		for _, pl := range p.Plans {
			if c.PlanTier(p, pl) != TierFree || pl.IncludedUnits == nil {
				continue
			}
			if !containsFold(pl.Note, "DERIVED") {
				continue
			}
			if !p.isReference() {
				t.Errorf("%s/%s calls its allowance DERIVED but the provider is ranked", p.Slug, pl.ID)
			}
		}
	}
}

func containsFold(hay, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(hay); i++ {
		if eqFold(hay[i:i+len(needle)], needle) {
			return true
		}
	}
	return false
}

func eqFold(a, b string) bool {
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 32
		}
		if 'A' <= y && y <= 'Z' {
			y += 32
		}
		if x != y {
			return false
		}
	}
	return true
}
