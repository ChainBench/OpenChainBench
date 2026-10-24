package main

import "testing"

// sideMixDiverges is the rule the publisher applies, extracted so it can be
// tested without building a whole entry.
//
// Pump Bridge was the board's number one at 209.7 bps on a sample that was
// 96.2 % buys, while roughly 43 % of what it drew were sales. A sell join
// rate of 7.8 % does not make the buy figure wrong; it makes it a BUY
// figure, ranked first as though it covered both directions.
func sideMixDiverges(parsed, buys, unpricedSales int) (drawnShare, pricedShare float64, diverges bool) {
	if unpricedSales <= 0 || parsed <= 0 {
		return 0, 0, false
	}
	pricedSells := float64(parsed - buys)
	drawnSells := pricedSells + float64(unpricedSales)
	drawn := drawnSells + float64(buys)
	if drawn <= 0 {
		return 0, 0, false
	}
	drawnShare = 100 * drawnSells / drawn
	pricedShare = 100 * pricedSells / float64(parsed)
	return drawnShare, pricedShare, drawnShare-pricedShare > 20
}

func TestPumpBridgeSideMixIsCaught(t *testing.T) {
	// The real shape: about 3,108 buys priced, about 123 sells priced,
	// 2,123 sales rejected unjoined plus 102 unpriced.
	drawn, priced, bad := sideMixDiverges(3231, 3108, 2225)
	if !bad {
		t.Fatalf("drawn %.0f%% sales against priced %.0f%%: this must withhold the rank", drawn, priced)
	}
	if drawn < 40 || drawn > 46 {
		t.Errorf("drawn sale share %.1f%%, expected about 43%%", drawn)
	}
	if priced > 5 {
		t.Errorf("priced sale share %.1f%%, expected about 4%%", priced)
	}
}

// A row whose sides join normally must keep its rank. The rule has to catch
// the mix, not every route that has any unjoined sale at all.
func TestABalancedRowKeepsItsRank(t *testing.T) {
	// 1,000 parsed, 520 buys, 480 sells priced, 60 sales missed: the drawn
	// share moves a few points, nowhere near twenty.
	drawn, priced, bad := sideMixDiverges(1000, 520, 60)
	if bad {
		t.Fatalf("drawn %.1f%% against priced %.1f%% was treated as divergent", drawn, priced)
	}
}

// No unpriced sales at all means the question does not arise: a route with
// only buys by nature must not be withheld by THIS rule, which is about a
// mix we can see failing. The one-side hold is what covers that case.
func TestNoUnpricedSalesMeansNoVerdict(t *testing.T) {
	if _, _, bad := sideMixDiverges(500, 500, 0); bad {
		t.Fatal("a row with no unpriced sales was withheld by the mix rule")
	}
}

// Exactly at the threshold the rank stands: the rule is strictly greater, so
// a borderline row is published rather than silently held.
func TestThresholdIsStrict(t *testing.T) {
	// 100 parsed all buys, 25 sales missed -> drawn 20 %, priced 0 %.
	drawn, priced, bad := sideMixDiverges(100, 100, 25)
	if drawn != 20 || priced != 0 {
		t.Fatalf("setup gave drawn %.1f priced %.1f, wanted 20 and 0", drawn, priced)
	}
	if bad {
		t.Fatal("a divergence of exactly 20 points was withheld; the rule must be strict")
	}
}
