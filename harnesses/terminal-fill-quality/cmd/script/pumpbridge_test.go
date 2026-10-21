package main

import "testing"

// Pump Bridge's EVM routers are declared as ordinary evmTerminal rows, which
// works only because productOf splits "pump-fun-bnb" into the pump-fun row on
// the bnb tab. If a chain ever leaves productChains, the split stops happening,
// the row lands under a slug the spec does not read, and the figures vanish
// from the page with nothing failing. That is the failure this pins.
func TestPumpBridgeRowsSplitIntoThePumpFunRow(t *testing.T) {
	want := map[string]string{
		"pump-fun-bnb":       "bnb",
		"pump-fun-base":      "base",
		"pump-fun-arc":       "arc",
		"pump-fun-robinhood": "robinhood",
		"pump-fun-megaeth":   "megaeth",
		"pump-fun-xlayer":    "xlayer",
	}
	for slug, chain := range want {
		product, got := productOf(slug)
		if product != "pump-fun" {
			t.Errorf("%s: product = %q, want pump-fun", slug, product)
		}
		if got != chain {
			t.Errorf("%s: chain = %q, want %q", slug, got, chain)
		}
	}
}

// The routers are the measurement. A typo in one is not a compile error and not
// a runtime error either: eth_getLogs on an address that does not exist returns
// an empty list forever, so the row simply never fills.
func TestPumpBridgeRoutersAreDeclaredOnEveryChainWeCover(t *testing.T) {
	const generic = "0x836b336fca26913176efc45a5a6e5e72cd7bd13b"
	const robinhood = "0x5399d94d2cab7c252a6034042e1917a0e5e17a18"

	seen := map[string][]string{}
	for _, e := range evmTerminals {
		if p, _ := productOf(e.Slug); p == "pump-fun" {
			seen[e.Chain] = e.Routers
		}
	}
	for chain, router := range map[string]string{
		"bnb": generic, "base": generic, "arc": generic, "robinhood": robinhood,
		"megaeth": generic, "xlayer": generic,
	} {
		got, ok := seen[chain]
		if !ok {
			t.Errorf("no pump.fun row declared on %s", chain)
			continue
		}
		if len(got) != 1 || got[0] != router {
			t.Errorf("%s: routers = %v, want [%s]", chain, got, router)
		}
	}
	if len(seen) != 6 {
		t.Errorf("pump.fun EVM rows = %d, want 6", len(seen))
	}
}

// No Collector is deliberate and is the one thing about these rows a reader
// could get wrong. The router forwards the whole purchase to the user; pump's
// own take is deducted on the Solana deposit and is not visible on this leg.
// Setting a Collector here would attribute a fee to an address that never
// receives one.
func TestPumpBridgeRowsDeclareNoCollector(t *testing.T) {
	for _, e := range evmTerminals {
		if p, _ := productOf(e.Slug); p != "pump-fun" {
			continue
		}
		if e.Collector != "" {
			t.Errorf("%s declares Collector %q; the EVM leg takes no fee",
				e.Slug, e.Collector)
		}
		if e.Tip != 0 || e.TipTo != "" {
			t.Errorf("%s declares a tip; none was observed on these fills", e.Slug)
		}
	}
}
