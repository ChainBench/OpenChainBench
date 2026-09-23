package main

import (
	"math"
	"testing"
)

// The whole harness exists because of this join. GMX's fee adapters are
// per product and none of them carries a token; the token sits on
// "parent#gmx", which has no row in /protocols at all. Resolving only
// through the adapter's own row is what limited the cohort to 90 tokens.
func TestTheTokenComesFromTheParentWhenTheAdapterHasNone(t *testing.T) {
	fees := []feeAdapter{
		{Name: "GMX V1 Perps", DefillamaID: "337", ParentProtocol: "parent#gmx", Category: "Derivatives", Total30d: 2e6, Total60dto30d: 1e6},
		{Name: "GMX V2 Perps", DefillamaID: "3365", ParentProtocol: "parent#gmx", Category: "Derivatives", Total30d: 3e6, Total60dto30d: 2e6},
	}
	protocols := []llamaProtocol{
		{ID: float64(337), Name: "GMX V1 Perps", ParentProtocol: "parent#gmx"},
		{ID: float64(3365), Name: "GMX V2 Perps", ParentProtocol: "parent#gmx"},
	}
	parents := []llamaParent{{ID: "parent#gmx", Name: "GMX", GeckoID: "gmx"}}

	cohort, st, err := joinCohort(fees, protocols, parents, 1e5)
	if err != nil {
		t.Fatal(err)
	}
	if len(cohort) != 1 {
		t.Fatalf("got %d rows, want 1: two adapters on one token is one valuation", len(cohort))
	}
	got := cohort[0]
	if got.GeckoID != "gmx" || got.Name != "GMX" {
		t.Fatalf("resolved to %q / %q, want gmx / GMX", got.GeckoID, got.Name)
	}
	// Summed, not ranked apart: one market cap divided by the fees of one
	// product would price the token several times over.
	if got.Fees30d != 5e6 || got.Prev30d != 3e6 {
		t.Fatalf("fees %v / prev %v, want 5e6 / 3e6", got.Fees30d, got.Prev30d)
	}
	if st.ViaParent != 1 || st.Merged != 1 {
		t.Fatalf("stats via_parent=%d merged=%d, want 1 / 1", st.ViaParent, st.Merged)
	}
}

// Without the parent link the same payload resolves nothing, which is the
// state this harness replaces.
func TestWithoutTheParentTableTheJoinFindsNothing(t *testing.T) {
	fees := []feeAdapter{{Name: "GMX V2 Perps", DefillamaID: "3365", ParentProtocol: "parent#gmx", Total30d: 3e6}}
	protocols := []llamaProtocol{{ID: float64(3365), Name: "GMX V2 Perps", ParentProtocol: "parent#gmx"}}

	cohort, st, _ := joinCohort(fees, protocols, nil, 1e5)
	if len(cohort) != 0 || st.Unmapped != 1 {
		t.Fatalf("got %d rows, unmapped=%d; want 0 / 1", len(cohort), st.Unmapped)
	}
}

// defillamaId arrives as a JSON number on /protocols and as a string on
// /overview/fees. A join that does not normalise them silently resolves
// zero rows while every fetch reports success.
func TestTheIDJoinSurvivesTheNumberVsStringMismatch(t *testing.T) {
	fees := []feeAdapter{{Name: "Aave V3", DefillamaID: "111", Category: "Lending", Total30d: 9e6}}
	protocols := []llamaProtocol{{ID: float64(111), Name: "Aave V3", GeckoID: "aave"}}
	cohort, _, _ := joinCohort(fees, protocols, nil, 1e5)
	if len(cohort) != 1 || cohort[0].GeckoID != "aave" {
		t.Fatalf("id normalisation failed: %+v", cohort)
	}
}

// A P/F on a token with almost nothing circulating divides a market cap
// that barely exists by real fees. Six of the twelve cheapest rows were
// this before the floor (2026-09-23).
func TestALowFloatTokenIsNotACheapProtocol(t *testing.T) {
	cohort := []Protocol{
		{Slug: "tiny", GeckoID: "tiny", Category: "Dexs", Fees30d: 1e6},
		{Slug: "real", GeckoID: "real", Category: "Dexs", Fees30d: 1e6},
	}
	markets := map[string]cgMarket{
		"tiny": {Mcap: 1e6, Circ: 4, Total: 100},  // 4 % float
		"real": {Mcap: 5e7, Circ: 80, Total: 100}, // 80 %
	}
	rows := buildRows(cohort, markets, 10)
	if len(rows) != 1 || rows[0].Slug != "real" {
		t.Fatalf("got %d rows (%v); the 4 %% float row must be dropped", len(rows), rows)
	}
	withoutFloor := buildRows(cohort, markets, 0)
	if len(withoutFloor) != 2 {
		t.Fatalf("with no floor both rows should publish, got %d", len(withoutFloor))
	}
	// And it would have led the board: 0.08 against 4.11.
	var tiny, real float64
	for _, r := range withoutFloor {
		if r.Slug == "tiny" {
			tiny = r.PF
		} else {
			real = r.PF
		}
	}
	if tiny >= real {
		t.Fatalf("expected the low-float row to look cheapest (%.2f vs %.2f)", tiny, real)
	}
	t.Logf("unfloored: tiny P/F %.2f leads real P/F %.2f", tiny, real)
}

// A category median over one or two tokens is not a peer comparison, and a
// row called cheap against it is cheap against an accident.
func TestASmallCategoryPublishesNoMedian(t *testing.T) {
	cohort := []Protocol{}
	markets := map[string]cgMarket{}
	for i, name := range []string{"a", "b", "c", "d", "e"} {
		cohort = append(cohort, Protocol{Slug: name, GeckoID: name, Category: "Dexs", Fees30d: 1e6})
		markets[name] = cgMarket{Mcap: float64(i+1) * 1e7, Circ: 90, Total: 100}
	}
	cohort = append(cohort, Protocol{Slug: "lonely", GeckoID: "lonely", Category: "Oracle", Fees30d: 1e6})
	markets["lonely"] = cgMarket{Mcap: 1e7, Circ: 90, Total: 100}

	rows := buildRows(cohort, markets, 10)
	medians := CategoryMedians(rows)
	if _, ok := medians["Dexs"]; !ok {
		t.Fatalf("a 5-token category should have a median: %v", medians)
	}
	if _, ok := medians["Oracle"]; ok {
		t.Fatalf("a 1-token category must not publish a median")
	}
	for _, r := range rows {
		if r.Slug == "lonely" && r.HasPeerGroup {
			t.Fatalf("the lone Oracle row claims a peer group")
		}
	}
}

// The screen is the point of the board, and its third clause is what keeps
// it from naming everything having a bad month.
func TestDivergingNeedsAllThreeClauses(t *testing.T) {
	base := Row{
		HasFeeGrowth: true, HasPriceChg: true, HasPF: true, HasPeerGroup: true,
		FeeGrowthPct: 40, PriceChgPct: -12, PF: 2, CategoryMedianPF: 8,
	}
	if !base.Diverging() {
		t.Fatal("fees up, price down, cheap against peers should fire")
	}

	feesDown := base
	feesDown.FeeGrowthPct = -5
	priceUp := base
	priceUp.PriceChgPct = 3
	expensive := base
	expensive.PF = 20
	noPeers := base
	noPeers.HasPeerGroup = false
	for name, r := range map[string]Row{
		"fees down": feesDown, "price up": priceUp,
		"expensive vs peers": expensive, "no peer group": noPeers,
	} {
		if r.Diverging() {
			t.Errorf("%s should not fire", name)
		}
	}
}

func TestAnnualizeMatchesTheOtherValuationBenches(t *testing.T) {
	// 30d x 365/30, the same cut benches 234 and 265 use, so the three
	// boards stay comparable.
	if got := annualize(30); math.Abs(got-365) > 1e-9 {
		t.Fatalf("annualize(30) = %v, want 365", got)
	}
}

func TestSlugifyIsStableAcrossPunctuation(t *testing.T) {
	cases := map[string]string{
		"GMX":                  "gmx",
		"pump.fun":             "pump-fun",
		"Aave":                 "aave",
		"Inverse Finance FiRM": "inverse-finance-firm",
		"fly.trade":            "fly-trade",
		"  Spaced  Out  ":      "spaced-out",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}
