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

// BNB was on the reference clock from 2026-10-03 to 2026-11-01, then moved
// to the race (#3441): its reference won 2.99% of races and 91% of the
// fastest feeds' samples were discarded for beating it. Putting it back
// would score each provider only on the trades where it was slower.
func TestBNBRacesRatherThanReferences(t *testing.T) {
	if referenceChains["bnb"] {
		t.Error("bnb's reference is beaten on 97% of trades; it belongs in raceChains")
	}
	if !raceChains["bnb"] {
		t.Error("bnb must stay in raceChains")
	}
}

// Base stays on the reference clock: its zero point is our own subscription
// to the sequencer node (sealed 200 ms blocks since Denim, 2026-11-05).
func TestBaseStaysOnTheReferenceClock(t *testing.T) {
	if !referenceChains["base"] {
		t.Fatal("base must read our sequencer reference, not the provider timestamp")
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
