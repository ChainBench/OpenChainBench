package main

import "testing"

// Every quote route must price the same ladder, or the depth reading compares
// providers on rungs they were not all asked about.
//
// Caught during the change that added the rung: the TRUMP route took a fourth
// UsdAmounts entry while its Amounts stayed at three, because its amounts are
// token-denominated and the others are USD. The quote loop ranges over
// Amounts, so the extra USD entry was silently unreachable and that corridor
// would have been missing from the depth comparison without any error.
func TestQuoteLaddersAreSymmetric(t *testing.T) {
	for _, r := range GetTestRoutes() {
		if len(r.UsdAmounts) != len(r.Amounts) {
			t.Errorf("route %s: %d amounts but %d USD labels; the quote loop ranges over Amounts, so the extra label is unreachable",
				r.Name, len(r.Amounts), len(r.UsdAmounts))
		}
	}
}

// The depth rung is what answers "does this provider shield a user from thin
// liquidity". A route without it cannot contribute to that reading.
func TestEveryQuoteRouteCarriesTheDepthRung(t *testing.T) {
	for _, r := range GetTestRoutes() {
		found := false
		for _, u := range r.UsdAmounts {
			if u == depthProbeUSD {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("route %s has no $%.0f rung, so it cannot answer the depth question",
				r.Name, depthProbeUSD)
		}
	}
}

// The depth probe must never reach the execution path. Quotes cost nothing;
// signing a $25,000 transfer would empty the wallet many times over.
func TestDepthRungIsFarAboveAnythingExecuted(t *testing.T) {
	const largestExecutedUSD = 30.0 // the execution ladder in main.go
	if depthProbeUSD <= largestExecutedUSD*100 {
		t.Fatalf("depth rung $%.0f sits close to the executed ladder; if the two were ever confused the harness would sign it",
			depthProbeUSD)
	}
}
