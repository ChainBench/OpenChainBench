package main

import (
	"strings"
	"testing"
)

// The funding test must look at the settlement stable, and nothing else.
//
// A buy sends the memecoin INTO the router on its way to the user. An earlier
// version accepted any ERC20 transfer to the router as evidence the sender had
// funded the trade, so every row read as user funded and the gross-up never
// fired once: 16 of 16 published with no reconstruction, silently.
//
// A guard too broad is not a safe guard, it is the feature switched off.
func TestEveryPumpRowKnowsItsSettlementStable(t *testing.T) {
	// A row with no declared stable is not grossed up at all, which is the
	// safe side: the funding test cannot run on it, and adding a deduction to
	// a trade the sender may have funded locally is the error that makes a
	// competitor look dearer. Three of the six chains are in that state.
	for _, term := range evmTerminals {
		if !pumpBridgeRow(term.Slug) {
			continue
		}
		stable := pumpStableOf(term.Slug)
		if stable == "" {
			if _, ok := pumpGrossUp(term.Slug, 10); ok {
				t.Errorf("%s has no settlement stable yet is grossed up, so it "+
					"claims a deduction with no funding test behind it", term.Slug)
			}
			continue
		}
		if _, ok := pumpGrossUp(term.Slug, 10); !ok {
			t.Errorf("%s names a stable but is not grossed up", term.Slug)
		}
		if !strings.HasPrefix(stable, "0x") || len(stable) != 42 {
			t.Errorf("%s: %q is not an address", term.Slug, stable)
		}
	}
}

// The stable named must be the one the take watcher reads, or the funding test
// and the fee measurement would disagree about what the router pays with.
func TestFundingStableMatchesTheWatchers(t *testing.T) {
	for _, r := range pumpRouters {
		slug := "pump-fun-" + r.chain
		if got := pumpStableOf(slug); !strings.EqualFold(got, r.token) {
			t.Errorf("%s: funding test uses %s, the watcher reads %s",
				slug, got, r.token)
		}
	}
}

// A row that is not pump's has no stable, so the guard never fires on it.
func TestOtherProductsHaveNoFundingStable(t *testing.T) {
	for _, slug := range []string{"fomo", "gmgn-bnb", "banana-gun-ethereum", ""} {
		if got := pumpStableOf(slug); got != "" {
			t.Errorf("pumpStableOf(%q) returned %s", slug, got)
		}
	}
}
