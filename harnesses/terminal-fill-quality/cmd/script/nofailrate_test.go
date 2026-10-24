package main

import "testing"

// Pump Bridge must never publish a fail rate, at any sample size.
//
// Its failures are not EVM reverts: the EVM leg succeeds and the cross-chain
// delivery is what does or does not arrive, so the block sample finds zero
// reverts however long it runs. With 102 sampled transactions it cleared
// sampledEnough and published 0.00 % on All chains, BNB and Base, which made
// the best reliability figure on the board belong to the one route whose
// reliability this counter cannot see.
func TestPumpBridgeRowsPublishNoFailRate(t *testing.T) {
	seen := 0
	for _, et := range evmTerminals {
		if !isPumpBridgeSlug(et.Slug) {
			continue
		}
		seen++
		if !et.NoFailRate {
			t.Errorf("%s does not carry NoFailRate; it would publish a zero", et.Slug)
		}
		if !noFailRate(et.Slug) {
			t.Errorf("noFailRate(%q) is false; the guard would let the rate through", et.Slug)
		}
	}
	if seen == 0 {
		t.Fatal("no pump-bridge rows found; this test checked nothing")
	}
}

// The flag must be narrow. A route whose failures ARE visible has to keep
// publishing its rate, or this fix would blank the board instead of one row.
func TestNoFailRateIsNotSetOnRoutesWeCanMeasure(t *testing.T) {
	flagged, measured := 0, 0
	for _, et := range evmTerminals {
		if et.NoFailRate {
			flagged++
			if !isPumpBridgeSlug(et.Slug) {
				t.Errorf("%s carries NoFailRate but is not a pump-bridge row", et.Slug)
			}
			continue
		}
		measured++
		if noFailRate(et.Slug) {
			t.Errorf("noFailRate(%q) is true on a row that should still publish", et.Slug)
		}
	}
	if measured == 0 {
		t.Fatal("every EVM row is flagged; the fix would blank the board")
	}
	if flagged == 0 {
		t.Fatal("nothing is flagged; the blocker is not fixed")
	}
}

// An unknown slug must not be treated as unmeasurable: defaulting to true
// would silently withhold rates for every Solana and Relay row, which are
// counted exhaustively from the feed rather than estimated from a sample.
func TestUnknownSlugsStillPublish(t *testing.T) {
	for _, s := range []string{"", "fomo", "phantom-funding", "not-a-row"} {
		if noFailRate(s) {
			t.Errorf("noFailRate(%q) is true; only declared rows may be withheld", s)
		}
	}
}

func isPumpBridgeSlug(s string) bool {
	const p = "pump-bridge-"
	return len(s) > len(p) && s[:len(p)] == p
}
