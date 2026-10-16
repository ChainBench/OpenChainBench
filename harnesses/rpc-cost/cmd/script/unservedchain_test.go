package main

import "testing"

// A chain a provider does not serve should say so.
//
// The catalogue writes that as `ethereum: null` under weights, and a map
// lookup finds the key: the value unmarshals to an empty table, and the first
// method then fails for want of a weight. The verdict was right and the
// sentence was wrong, and the sentence is now reader-facing — the cost curve
// prints each unpriced provider's reason next to its name, so Syndica, Triton
// and Coinbase CDP were about to tell readers that nobody publishes a unit
// cost for eth_blockNumber.
func TestAnUnservedChainSaysSoRatherThanBlamingAMethod(t *testing.T) {
	pr := Profile{ID: "dapp", Chain: "ethereum", Mix: map[string]float64{
		"eth_blockNumber": 0.5, "eth_getBalance": 0.5,
	}}

	// `ethereum: null`: the key is present and the table is empty.
	solanaOnly := Provider{
		Slug: "triton", Cohort: "usage", Currency: "USD", Unit: "request",
		Weights: map[string]Weights{
			"ethereum": {},
			"solana":   {Default: f(1)},
		},
	}
	if _, err := unitsPerRequest(solanaOnly, pr); err == nil {
		t.Fatal("an unpriced chain must not price")
	} else if got, want := err.Error(), "provider does not price ethereum"; got != want {
		t.Errorf("reason is %q, want %q", got, want)
	}

	// A table that really is missing one method still names the method: that
	// is a different fact about a chain the provider does price, and Alchemy
	// publishes no fallback for methods absent from its list.
	partial := Provider{
		Slug: "alchemy", Cohort: "usage", Currency: "USD", Unit: "cu",
		Weights: map[string]Weights{
			"ethereum": {Methods: map[string]*float64{"eth_getBalance": f(11)}},
		},
	}
	if _, err := unitsPerRequest(partial, pr); err == nil {
		t.Fatal("a missing method must not price")
	} else if got, want := err.Error(), "no published unit cost for eth_blockNumber"; got != want {
		t.Errorf("reason is %q, want %q", got, want)
	}

	// And a chain absent from the map entirely reads the same as a null one,
	// because to a reader they are the same fact.
	absent := Provider{
		Slug: "helius-dedicated", Cohort: "dedicated", Currency: "USD", Unit: "request",
		Weights: map[string]Weights{"solana": {Default: f(1)}},
	}
	if _, err := unitsPerRequest(absent, pr); err == nil {
		t.Fatal("an absent chain must not price")
	} else if got, want := err.Error(), "provider does not price ethereum"; got != want {
		t.Errorf("reason is %q, want %q", got, want)
	}
}
