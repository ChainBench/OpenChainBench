package main

import "testing"

// A funding row's legs are transfers and must never be timed as trades.
//
// xchainRows() always includes <app>-funding, including for apps whose Relay
// legs are ONLY funding. Both timing paths took the slug and trusted it, so
// BasedBot, which makes no bridged trade at all, published 689 trade-labelled
// settlements and a 1,423 ms figure on the site, beside a methodology line
// saying those legs are not trades. The same legs were also being timed
// correctly as funding, so one transfer was counted into both populations
// that settleKey exists to keep apart.
func TestFundingRowsAreNotTimedAsTrades(t *testing.T) {
	for _, slug := range []string{
		"basedbot-funding", "phantom-funding", "pump-fun-funding", "fomo-funding",
	} {
		product, chain := settleRoute(slug)
		if product == "" {
			t.Errorf("%s resolved to no product; the guard would never be reached", slug)
			continue
		}
		if chain != "funding" {
			t.Errorf("%s resolved to chain %q, want funding: the guard keys on this", slug, chain)
		}
	}
}

// And the guard must be narrow: a real bridged row has to keep being timed,
// or the fix would empty the settlement panel instead of correcting it.
func TestBridgedRowsStillResolveToAChain(t *testing.T) {
	for slug, want := range map[string]string{
		"fomo-bnb":           "bnb",
		"phantom-base":       "base",
		"pump-fun-ethereum":  "ethereum",
		"fomo-mobula-robinhood": "robinhood",
	} {
		product, chain := settleRoute(slug)
		if product == "" {
			t.Errorf("%s resolved to no product", slug)
		}
		if chain != want {
			t.Errorf("%s resolved to chain %q, want %q", slug, chain, want)
		}
		if chain == "funding" {
			t.Errorf("%s would be skipped by the funding guard; it is a bridged row", slug)
		}
	}
}
