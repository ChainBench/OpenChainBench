package main

import "testing"

// A fail rate of 0% computed from zero observations is an absence, not a
// measurement, and it is indistinguishable on the page from a route that
// genuinely never fails.
//
// On a native EVM row failures can ONLY come from the block sample, because a
// reverted transaction emits no logs. So `SampSeen == 0` there means nothing
// was looked at. The guard used to allow it, and maestro-robinhood and
// pump-bridge-robinhood both published 0% off an empty sample while
// bloom-robinhood (1 sampled) and pump-fun-robinhood (4) were held back.
//
// These pin the rule per row kind rather than the arithmetic, because the
// arithmetic was never wrong.
func TestUnsampledNativeEvmRowPublishesNoFailRate(t *testing.T) {
	// Every native EVM row must be recognised as one, or the guard exempts it
	// again by the same route.
	for _, e := range evmTerminals {
		if !isNativeEVM(e.Slug) {
			t.Errorf("%s is an evmTerminal but isNativeEVM says otherwise, so "+
				"an empty block sample would publish 0%% on it", e.Slug)
		}
	}
	// And a Solana row must NOT be, or the exemption it legitimately relies on
	// disappears and its fail rate stops publishing entirely.
	for _, name := range []string{"fomo", "pump-fun", "axiom", "gmgn"} {
		if isNativeEVM(name) {
			t.Errorf("%s is a Solana row; treating it as native EVM would "+
				"withhold a fail rate it measures properly from the feed", name)
		}
	}
}

// The Solana exemption exists because those rows count failures from the feed
// rather than estimating them from a sample. If a Solana row ever started
// reporting SampSeen, this assumption would need revisiting rather than
// silently changing which rows publish.
func TestSolanaRowsAreNotBlockSampled(t *testing.T) {
	for _, c := range cohort() {
		if _, chain := productOf(c.Slug); chain != "solana" {
			continue
		}
		if isNativeEVM(c.Slug) {
			t.Errorf("%s is on Solana but is declared as a native EVM row", c.Slug)
		}
	}
}
