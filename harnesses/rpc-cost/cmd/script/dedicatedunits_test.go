package main

import "testing"

// The units_per_request panel was blank for every dedicated provider while
// the model billed them at one unit a request (audit 2026-10-22, A10).
func TestDedicatedProvidersPublishOneUnitPerRequestOnTheirChains(t *testing.T) {
	eth := Profile{ID: "dapp", Chain: "ethereum", Mix: map[string]float64{"eth_call": 1}}
	sol := Profile{ID: "solana-bot", Chain: "solana", Mix: map[string]float64{"getAccountInfo": 1}}
	node := Provider{Slug: "x-dedicated", Cohort: "dedicated", Unit: "request",
		Plans: []Plan{{ID: "eth-node", Chains: []string{"ethereum"}}}}
	if upr, err := publishedUnitsPerRequest(node, eth); err != nil || upr != 1 {
		t.Fatalf("ethereum: got %v, %v; want 1, nil", upr, err)
	}
	if _, err := publishedUnitsPerRequest(node, sol); err == nil {
		t.Fatal("a chain no plan serves must publish nothing")
	}
	usage := Provider{Slug: "y", Cohort: "usage", Unit: "cu",
		Weights: map[string]Weights{"ethereum": {Default: f(26)}}}
	if upr, err := publishedUnitsPerRequest(usage, eth); err != nil || upr != 26 {
		t.Fatalf("usage provider must keep its method table: got %v, %v", upr, err)
	}
}
