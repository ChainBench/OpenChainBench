package main

import (
	"path/filepath"
	"testing"
)

// realCatalogue loads the shipped pricing file, so these assertions are about
// the data that is actually published and not about a fixture.
func realCatalogue(t *testing.T) *Catalogue {
	t.Helper()
	c, err := LoadCatalogue(filepath.Join("..", "..", "pricing", "catalogue.yml"))
	if err != nil {
		t.Fatalf("load catalogue: %v", err)
	}
	return c
}

// A free plan serves the chains it declares and no others.
//
// dRPC is the case this exists for. Its free plan answers error 35, "chain is
// not available on free plan", on Solana, measured 2026-09-29 and recorded in
// its own note. But dRPC prices Solana on its paid plans, so unitsPerRequest
// resolves for a Solana workload and the chain test that every metered cohort
// leans on never fires. The board published a 10.5M Solana allowance for a
// plan that refuses Solana, three lines under the measurement saying so.
func TestFreePlanDoesNotClaimAChainItDeclinesToServe(t *testing.T) {
	c := realCatalogue(t)
	for _, p := range c.Providers {
		for _, pl := range p.Plans {
			if c.PlanTier(p, pl) != TierFree || len(pl.Chains) == 0 {
				continue
			}
			for _, pr := range Profiles {
				if servesChain(pl, pr.Chain) {
					continue
				}
				if _, planID, ok := c.FreeAllowanceRequests(p, pr); ok && planID == pl.ID {
					t.Errorf("%s/%s declares chains %v and still publishes an allowance for %s (%s)",
						p.Slug, pl.ID, pl.Chains, pr.Chain, pr.ID)
				}
			}
		}
	}
}

// Pins the specific row, so a catalogue edit that drops the line fails here
// rather than quietly restoring the figure.
func TestDrpcFreeIsEthereumOnly(t *testing.T) {
	c := realCatalogue(t)
	var found bool
	for _, p := range c.Providers {
		if p.Slug != "drpc" {
			continue
		}
		for _, pl := range p.Plans {
			if pl.ID != "free" {
				continue
			}
			found = true
			if len(pl.Chains) == 0 {
				t.Fatal("drpc/free declares no chains; its own note records Solana refusing the plan on 2026-09-29")
			}
			if servesChain(pl, "solana") {
				t.Errorf("drpc/free claims solana, chains = %v", pl.Chains)
			}
			if !servesChain(pl, "ethereum") {
				t.Errorf("drpc/free should serve ethereum, chains = %v", pl.Chains)
			}
		}
	}
	if !found {
		t.Fatal("drpc/free not found in the catalogue")
	}
}
