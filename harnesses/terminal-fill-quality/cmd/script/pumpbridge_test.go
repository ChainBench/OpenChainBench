package main

import "testing"

// Pump Bridge's EVM routers are declared as ordinary evmTerminal rows, which
// works only because productOf splits "pump-bridge-bnb" into the pump-bridge
// row on the bnb tab. If a chain ever leaves productChains, the split stops,
// the row lands under a slug the spec does not read, and the figures vanish
// from the page with nothing failing. That is the failure this pins.
func TestPumpBridgeRowsSplitIntoTheirOwnProduct(t *testing.T) {
	want := map[string]string{
		"pump-bridge-bnb":       "bnb",
		"pump-bridge-base":      "base",
		"pump-bridge-arc":       "arc",
		"pump-bridge-robinhood": "robinhood",
		"pump-bridge-megaeth":   "megaeth",
		"pump-bridge-xlayer":    "xlayer",
	}
	for slug, chain := range want {
		product, got := productOf(slug)
		if product != "pump-bridge" {
			t.Errorf("%s: product = %q, want pump-bridge", slug, product)
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
		if p, _ := productOf(e.Slug); p == "pump-bridge" {
			seen[e.Chain] = e.Routers
		}
	}
	for chain, router := range map[string]string{
		"bnb": generic, "base": generic, "arc": generic, "robinhood": robinhood,
		"megaeth": generic, "xlayer": generic,
		// Ethereum added 2026-10-23: the router is deployed and used there
		// and the chain already had a tab, so the route was measurable and
		// simply undeclared.
		"ethereum": generic,
	} {
		got, ok := seen[chain]
		if !ok {
			t.Errorf("no Pump Bridge row declared on %s", chain)
			continue
		}
		if len(got) != 1 || got[0] != router {
			t.Errorf("%s: routers = %v, want [%s]", chain, got, router)
		}
	}
	// The count is asserted so a row cannot be added or dropped unnoticed,
	// and the map above names which chains, so a change has to be made in
	// both places deliberately rather than by moving one number.
	if len(seen) != 7 {
		t.Errorf("Pump Bridge rows = %d, want 7", len(seen))
	}
}

// No Collector is deliberate and is the one thing about these rows a reader
// could get wrong. The router forwards the whole purchase to the user; pump's
// own take is deducted on the Solana deposit and is not visible on this leg.
// Setting a Collector here would attribute a fee to an address that never
// receives one.
func TestPumpBridgeRowsDeclareNoCollector(t *testing.T) {
	for _, e := range evmTerminals {
		if p, _ := productOf(e.Slug); p != "pump-bridge" {
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
