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

// The depth rungs are what answer "does this provider shield a user from thin
// liquidity". A route missing either cannot contribute to that reading, and
// two are needed rather than one: $25,000 does not move USDC on these
// corridors, so a single point there only re-measures the fee curve.
func TestEveryQuoteRouteCarriesBothDepthRungs(t *testing.T) {
	for _, r := range GetTestRoutes() {
		for _, want := range []float64{depthProbeUSD, depthProbeLargeUSD} {
			found := false
			for _, u := range r.UsdAmounts {
				if u == want {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("route %s has no $%.0f rung", r.Name, want)
			}
		}
	}
}

// The ladder must not grow. Each rung costs every provider 1,440 quotes a day,
// and the depth reading was bought by spending the redundant $50 rung rather
// than by adding a fifth: below the depth point cost% = F/amount + V, so $5
// and $300 already determine the fee curve and $50 sat on it to a median of
// 0.3%. Adding instead of swapping is how a free key gets revoked.
func TestLadderStaysFourRungs(t *testing.T) {
	for _, r := range GetTestRoutes() {
		if len(r.UsdAmounts) != 4 {
			t.Errorf("route %s has %d rungs; the ladder is budgeted at 4 per route per provider",
				r.Name, len(r.UsdAmounts))
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
