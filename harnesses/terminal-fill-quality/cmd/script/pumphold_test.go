package main

import "testing"

// Every pump.fun row on a Pump Bridge router must be recognised as one.
//
// The gross-up keys off pumpBridgeRow, so a row this misses keeps the router's
// net spend as its value given and publishes a loss on a smaller base than
// every other row on the same chain tab, FOMO included, whose bridge take is
// counted. That is not a missing number, it is a wrong ordering: pump would
// read cheaper than FOMO while it is dearer.
func TestEveryPumpRowIsRecognisedAsABridgeRow(t *testing.T) {
	found := 0
	for _, term := range evmTerminals {
		if len(term.Slug) < 9 || term.Slug[:9] != "pump-fun-" {
			continue
		}
		found++
		if !pumpBridgeRow(term.Slug) {
			t.Errorf("%q reads a Pump Bridge router but pumpBridgeRow says no, so it "+
				"would publish a loss missing the bridge's take", term.Slug)
		}
	}
	if found == 0 {
		t.Fatal("no pump.fun EVM row declared")
	}
	if found != 6 {
		t.Errorf("%d pump.fun EVM rows, expected 6 (bnb, base, arc, robinhood, megaeth, xlayer)", found)
	}
}

// And no other product's row may be caught by it.
//
// A false positive here inflates another product's cost by a fee it does not
// charge, which is the mirror of the bug being fixed and lands in the
// direction that makes a competitor look dearer.
func TestOnlyPumpRowsAreHeldAsBridgeRows(t *testing.T) {
	for _, term := range evmTerminals {
		if pumpBridgeRow(term.Slug) && (len(term.Slug) < 9 || term.Slug[:9] != "pump-fun-") {
			t.Errorf("%q is not a pump.fun row but pumpBridgeRow holds it", term.Slug)
		}
	}
	for _, slug := range []string{"fomo", "axiom-bnb", "banana-gun-ethereum", "gmgn-bnb", ""} {
		if pumpBridgeRow(slug) {
			t.Errorf("pumpBridgeRow(%q) is true; it must match only the bridge's routers", slug)
		}
	}
}

// The routers the take watcher reads must be the ones the rows declare.
//
// pumpRouters drives both the fee measurement and this hold. If it named an
// address no row carries, the fee would be measured for a router whose swaps
// are published by nobody, and the hold would protect nothing.
func TestTakeWatcherRoutersAreRowRouters(t *testing.T) {
	declared := map[string]bool{}
	for _, term := range evmTerminals {
		for _, r := range term.Routers {
			declared[lowerASCII(r)] = true
		}
	}
	for _, r := range pumpRouters {
		if !declared[lowerASCII(r.router)] {
			t.Errorf("pumpRouters names %s on %s, but no evmTerminal row declares it",
				r.router, r.chain)
		}
	}
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}
