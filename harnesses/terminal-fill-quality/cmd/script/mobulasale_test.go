package main

import "testing"

// The attribution this route turns on. R4rNJ... is FOMO's fee wallet as this
// bench declares it in config.go, and it is the address the measured sales
// carry, so the mapping must resolve it to fomo-mobula and nothing else to
// anything. If this test ever fails because a wallet moved, the row must go
// blank rather than start publishing another integrator's traffic.
func TestMobulaSaleAttributesOnlyDeclaredWallets(t *testing.T) {
	m := mobulaSaleWallets()
	const fomoFeeWallet = "R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX"
	if got := m[lower(fomoFeeWallet)]; got != "fomo-mobula" {
		t.Fatalf("FOMO's declared fee wallet maps to %q, want fomo-mobula", got)
	}
	if got, ok := m["someoneelseswallet"]; ok {
		t.Fatalf("an undeclared wallet resolved to %q; it must not match", got)
	}
	// Only routes on the Mobula rail may appear, whatever wallets a terminal
	// declares: a terminal with a fee wallet but no Mobula route must not
	// start publishing one.
	for _, product := range m {
		found := false
		for _, p := range settleRails["mobula"] {
			if p == product {
				found = true
			}
		}
		if !found {
			t.Fatalf("%q is attributed but is not a route on the Mobula rail", product)
		}
	}
}

// The direction is read off destinationChainId, which the API states, and a
// record with Solana on BOTH ends must be refused: timing it would difference
// two legs on one chain and call the result a settlement.
func TestMobulaSaleDirectionIsReadOffTheRecord(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		dest   string
		want   bool
	}{
		{"evm to solana", "evm:56", "solana:solana", true},
		{"ethereum to solana", "evm:1", "solana:solana", true},
		{"solana to evm is a buy", "solana:solana", "evm:56", false},
		{"evm to evm", "evm:1", "evm:56", false},
		{"solana to solana", "solana:solana", "solana:solana", false},
		{"empty", "", "", false},
	}
	for _, c := range cases {
		r := mobulaIntentRec{OriginChain: c.origin, DestChain: c.dest}
		if got := r.isSale(); got != c.want {
			t.Errorf("%s: isSale = %v, want %v", c.name, got, c.want)
		}
	}
}

// The origin chain comes from the record's chain id and must resolve to a
// chain this bench actually reads, or the settlement would be built on a
// receipt fetched from the wrong network.
func TestMobulaSaleOriginChainResolves(t *testing.T) {
	if oc, ok := (mobulaIntentRec{OriginChain: "evm:56"}).originEvmChain(); !ok || oc.slug != "bnb" {
		t.Fatalf("evm:56 resolved to %q (ok=%v), want bnb", oc.slug, ok)
	}
	if oc, ok := (mobulaIntentRec{OriginChain: "evm:4663"}).originEvmChain(); !ok || oc.slug != "robinhood" {
		t.Fatalf("evm:4663 resolved to %q (ok=%v), want robinhood", oc.slug, ok)
	}
	for _, bad := range []string{"evm:999999", "solana:solana", "evm:", "", "nocolon"} {
		if _, ok := (mobulaIntentRec{OriginChain: bad}).originEvmChain(); ok {
			t.Errorf("%q resolved to a chain we read; it must not", bad)
		}
	}
}

func lower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}
