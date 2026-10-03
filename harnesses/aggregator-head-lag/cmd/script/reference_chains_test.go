package main

import "testing"

// A chain in referenceChains publishes head_lag_seconds as the lag behind our
// own clock; a chain outside it publishes the lag behind the provider's own
// timestamp. Those are different instruments, so no chain may be in both this
// map and raceChains, and every chain in either must be a bench pool.
func TestChainInstrumentsDoNotOverlap(t *testing.T) {
	for chain := range referenceChains {
		if raceChains[chain] {
			t.Errorf("%q is in both referenceChains and raceChains; the headline would "+
				"depend on which code path wrote last", chain)
		}
	}
	for _, m := range []map[string]bool{referenceChains, raceChains} {
		for chain := range m {
			found := false
			for _, p := range headLagPools {
				if p.ChainName == chain {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%q has no bench pool, so there is nothing to reference against", chain)
			}
		}
	}
}

// BNB moved onto the reference clock on 2026-10-03. Reverting it would restore
// a column whose dominant term is BNB's block time rather than any provider's
// pipeline: on the old instrument the four feeds sat within 9% of each other
// (eu-west p50 0.621 / 0.657 / 0.676 s), against the reference they spread over
// a factor of four (0.052 / 0.102 / 0.215 s), ranking unchanged.
//
// It also retired a published claim: the spec said BNB's chain-supplied
// timestamps sat "within roughly 60 ms of the moment a trade is observable".
// The gap between the two series is that quantity, and it measured 569 ms.
func TestBNBUsesTheReferenceClock(t *testing.T) {
	if !referenceChains["bnb"] {
		t.Fatal("bnb left referenceChains. That republishes the provider's own timestamp " +
			"as the zero point, which measures BNB's block time more than any provider, " +
			"and it re-blocks OKX on that chain because OKX sends whole-second timestamps.")
	}
}

// Base stays on the reference clock: its zero point is the flashblock
// preconfirmation stream, which precedes the sealed block by ~1.6 s.
func TestBaseStaysOnTheReferenceClock(t *testing.T) {
	if !referenceChains["base"] {
		t.Fatal("base must read the flashblock reference, not the provider timestamp")
	}
}

// Solana is deliberately NOT a referenceChain: no RPC WebSocket we can hold
// precedes the providers' geyser feeds, so it races instead.
func TestSolanaRacesRatherThanReferences(t *testing.T) {
	if referenceChains["solana"] {
		t.Error("solana has no reference that beats the providers' geyser feeds; " +
			"it belongs in raceChains")
	}
	if !raceChains["solana"] {
		t.Error("solana must stay in raceChains")
	}
}
