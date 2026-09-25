package main

import (
	"math"
	"testing"
)

// Revenue rides on the fee adapter, so a token's revenue spans exactly the
// adapters its fees do, and a token whose adapters publish no revenue
// series has none rather than zero. TVL is parent scope: every /protocols
// row that resolves to the token counts, fee adapter or not.
func TestRevenueSumsOverTheSameAdaptersAsFees(t *testing.T) {
	fees := []feeAdapter{
		{Name: "Uniswap V2", DefillamaID: "2197", Category: "Dexs", Total30d: 2e6},
		{Name: "Uniswap V3", DefillamaID: "2198", Category: "Dexs", Total30d: 8e6},
		{Name: "Aave V3", DefillamaID: "1599", ParentProtocol: "parent#aave", Category: "Lending", Total30d: 5e6},
	}
	revenue := []feeAdapter{
		{Name: "Uniswap V2", DefillamaID: "2197", Total30d: 1e5},
		{Name: "Uniswap V3", DefillamaID: "2198", Total30d: 3e5},
		// A revenue row for an adapter that is not in the fee list must not
		// leak into anyone's total.
		{Name: "Orphan", DefillamaID: "9999", Total30d: 7e5},
	}
	protocols := []llamaProtocol{
		{ID: float64(2197), Name: "Uniswap V2", GeckoID: "uniswap", TVL: 1e9},
		{ID: float64(2198), Name: "Uniswap V3", GeckoID: "uniswap", TVL: 3e9},
		{ID: float64(1599), Name: "Aave V3", ParentProtocol: "parent#aave", TVL: 18e9},
		// A parent-scope row with no fee adapter still counts toward TVL.
		{ID: float64(1600), Name: "Aave Horizon RWA", ParentProtocol: "parent#aave", TVL: 2e9},
	}
	parents := []llamaParent{{ID: "parent#aave", Name: "Aave", GeckoID: "aave"}}

	cohort, _, err := joinCohort(fees, revenue, protocols, parents, 1e5)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Protocol{}
	for _, p := range cohort {
		by[p.GeckoID] = p
	}
	if got := by["uniswap"].Rev30d; got != 4e5 {
		t.Errorf("uniswap revenue = %v, want 4e5 (V2 + V3)", got)
	}
	if got := by["aave"].Rev30d; got != 0 {
		t.Errorf("aave revenue = %v, want 0: no revenue row for its adapter", got)
	}
	if got := by["uniswap"].TVL; got != 4e9 || !by["uniswap"].HasTVL {
		t.Errorf("uniswap TVL = %v (has=%v), want 4e9", got, by["uniswap"].HasTVL)
	}
	if got := by["aave"].TVL; got != 20e9 {
		t.Errorf("aave TVL = %v, want 20e9 (V3 + Horizon through the parent)", got)
	}
}

// A token with no /protocols row carrying TVL has no TVL, not a zero.
func TestATokenWithNoLockedValueHasNoTVL(t *testing.T) {
	fees := []feeAdapter{{Name: "Pump", DefillamaID: "1", Category: "Launchpad", Total30d: 5e6}}
	protocols := []llamaProtocol{{ID: float64(1), Name: "Pump", GeckoID: "pump-fun"}}
	cohort, _, err := joinCohort(fees, nil, protocols, nil, 1e5)
	if err != nil {
		t.Fatal(err)
	}
	if len(cohort) != 1 || cohort[0].HasTVL {
		t.Fatalf("got %+v, want one row without TVL", cohort)
	}
}

// A silent revenue adapter marks the revenue total short the way a silent
// fee adapter marks the fee total, and a fee-incomplete token is revenue
// incomplete by construction.
func TestASilentRevenueAdapterMarksRevenueIncomplete(t *testing.T) {
	fees := []feeAdapter{
		{Name: "A Perps", DefillamaID: "1", Category: "Derivatives", Total30d: 5e6, Total1y: 5e7},
		{Name: "B Perps", DefillamaID: "2", Category: "Derivatives", Total30d: 5e6, Total1y: 5e7},
	}
	revenue := []feeAdapter{
		{Name: "A Perps", DefillamaID: "1", Total30d: 0, Total1y: 5e6},
		{Name: "B Perps", DefillamaID: "2", Total30d: 1e6, Total1y: 5e6},
	}
	protocols := []llamaProtocol{
		{ID: float64(1), Name: "A", GeckoID: "a"},
		{ID: float64(2), Name: "B", GeckoID: "b"},
	}
	cohort, _, err := joinCohort(fees, revenue, protocols, nil, 1e5)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Protocol{}
	for _, p := range cohort {
		by[p.GeckoID] = p
	}
	if !by["a"].RevIncomplete || by["a"].Incomplete {
		t.Errorf("a: revenue silent after a year of revenue should be revenue-incomplete only, got %+v", by["a"])
	}
	if by["b"].RevIncomplete {
		t.Errorf("b: a live revenue adapter is not incomplete")
	}
}

// A product earning fees this month with no revenue row while a sibling
// has one is a coverage gap: the revenue total is short and the P/S on it
// would be inflated, so the token is flagged. A token with no revenue row
// anywhere is unknown, not partial.
func TestPartialRevenueCoverageIsIncomplete(t *testing.T) {
	fees := []feeAdapter{
		{Name: "GMX V1", DefillamaID: "1", ParentProtocol: "parent#gmx", Category: "Derivatives", Total30d: 4e6},
		{Name: "GMX V2", DefillamaID: "2", ParentProtocol: "parent#gmx", Category: "Derivatives", Total30d: 4e6},
		{Name: "GMX Retired", DefillamaID: "3", ParentProtocol: "parent#gmx", Category: "Derivatives", Total30d: 0},
		{Name: "Pump", DefillamaID: "4", Category: "Launchpad", Total30d: 5e6},
	}
	revenue := []feeAdapter{{Name: "GMX V1", DefillamaID: "1", Total30d: 1e6}}
	protocols := []llamaProtocol{
		{ID: float64(1), Name: "GMX V1", ParentProtocol: "parent#gmx"},
		{ID: float64(2), Name: "GMX V2", ParentProtocol: "parent#gmx"},
		{ID: float64(3), Name: "GMX Retired", ParentProtocol: "parent#gmx"},
		{ID: float64(4), Name: "Pump", GeckoID: "pump-fun"},
	}
	parents := []llamaParent{{ID: "parent#gmx", Name: "GMX", GeckoID: "gmx"}}
	cohort, _, err := joinCohort(fees, revenue, protocols, parents, 1e5)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Protocol{}
	for _, p := range cohort {
		by[p.GeckoID] = p
	}
	gmx := by["gmx"]
	if gmx.Rev30d != 1e6 || !gmx.RevIncomplete || gmx.RevMissingAdapters != 1 {
		t.Errorf("gmx: rev=%v incomplete=%v missing=%d, want 1e6, true, 1 (V2 earns fees with no revenue row; the retired product does not count)",
			gmx.Rev30d, gmx.RevIncomplete, gmx.RevMissingAdapters)
	}
	if pump := by["pump-fun"]; pump.RevIncomplete {
		t.Errorf("pump: no revenue row anywhere is unknown, not partial, got %+v", pump)
	}
	rows := buildRows(cohort, map[string]cgMarket{
		"gmx":      {ID: "gmx", Mcap: 1e9, FDV: 1e9, Circ: 1, Total: 1},
		"pump-fun": {ID: "pump-fun", Mcap: 1e9, FDV: 1e9, Circ: 1, Total: 1},
	}, 10)
	for _, r := range rows {
		if r.HasPS {
			t.Errorf("%s: no P/S on a short or unknown revenue total", r.GeckoID)
		}
	}
}

// A token whose revenue rows all report zero has a known zero, published
// as 0 with no P/S; a token with no revenue row anywhere is unknown and
// publishes nothing. The two must stay apart.
func TestAKnownZeroRevenueIsNotUnknown(t *testing.T) {
	fees := []feeAdapter{
		{Name: "Zero", DefillamaID: "1", Category: "Dexs", Total30d: 5e6},
		{Name: "Unknown", DefillamaID: "2", Category: "Dexs", Total30d: 5e6},
	}
	revenue := []feeAdapter{{Name: "Zero", DefillamaID: "1", Total30d: 0}}
	protocols := []llamaProtocol{
		{ID: float64(1), Name: "Zero", GeckoID: "zero"},
		{ID: float64(2), Name: "Unknown", GeckoID: "unknown"},
	}
	cohort, _, err := joinCohort(fees, revenue, protocols, nil, 1e5)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Protocol{}
	for _, p := range cohort {
		by[p.GeckoID] = p
	}
	if z := by["zero"]; !z.RevKnown || z.Rev30d != 0 || z.RevIncomplete {
		t.Errorf("zero: want known, 0, complete; got %+v", z)
	}
	if u := by["unknown"]; u.RevKnown {
		t.Errorf("unknown: no revenue row anywhere must not be known, got %+v", u)
	}
}

// P/S needs revenue. Zero or missing revenue is "unknown", and a ratio
// against unknown must be absent rather than infinite or zero.
func TestPSIsAbsentWithoutRevenue(t *testing.T) {
	cohort := []Protocol{
		{Slug: "with-rev", GeckoID: "a", Category: "Dexs", Fees30d: 3e6, Rev30d: 6e5},
		{Slug: "no-rev", GeckoID: "b", Category: "Dexs", Fees30d: 3e6, Rev30d: 0},
	}
	markets := map[string]cgMarket{
		"a": {ID: "a", Mcap: 730e6, FDV: 1e9, Circ: 73, Total: 100},
		"b": {ID: "b", Mcap: 730e6, FDV: 1e9, Circ: 73, Total: 100},
	}
	rows := buildRows(cohort, markets, 10)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if !rows[0].HasPS {
		t.Fatal("a row with revenue should carry a P/S")
	}
	// 6e5 * 365 / 30 = 7.3e6 annual revenue; 730e6 / 7.3e6 = 100.
	if math.Abs(rows[0].PS-100) > 1e-9 {
		t.Errorf("P/S = %v, want 100", rows[0].PS)
	}
	if rows[1].HasPS || rows[1].PS != 0 {
		t.Errorf("a row without revenue should have no P/S, got has=%v ps=%v", rows[1].HasPS, rows[1].PS)
	}
}
