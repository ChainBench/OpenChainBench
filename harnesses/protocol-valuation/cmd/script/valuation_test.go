package main

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

	cohort, st, err := joinCohort(fees, nil, protocols, parents, 1e5)
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

	cohort, st, _ := joinCohort(fees, nil, protocols, nil, 1e5)
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
	cohort, _, _ := joinCohort(fees, nil, protocols, nil, 1e5)
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
	rows := buildRows(cohort, markets, 10, 0)
	if len(rows) != 1 || rows[0].Slug != "real" {
		t.Fatalf("got %d rows (%v); the 4 %% float row must be dropped", len(rows), rows)
	}
	withoutFloor := buildRows(cohort, markets, 0, 0)
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

	rows := buildRows(cohort, markets, 10, 0)
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

// The category is the peer group, and the peer group is the comparison the
// page calls the column to read. Taking whichever adapter /overview/fees
// listed first filed Drift (a perp DEX) under Liquid Staking and Sanctum (a
// liquid staking protocol) under Dexs, which both read the wrong median and
// shifted the median their real peers read against.
func TestTheCategoryComesFromWhereTheFeesActuallyAre(t *testing.T) {
	fees := []feeAdapter{
		// Listed first, small: a spot DEX product of a perp protocol.
		{Name: "Drift Spot", DefillamaID: "1", ParentProtocol: "parent#drift", Category: "Dexs", Total30d: 100_000},
		// Listed later, large: the perp engine that is most of its fees.
		{Name: "Drift Perps", DefillamaID: "2", ParentProtocol: "parent#drift", Category: "Derivatives", Total30d: 900_000},
	}
	protocols := []llamaProtocol{
		{ID: float64(1), Name: "Drift Spot", ParentProtocol: "parent#drift"},
		{ID: float64(2), Name: "Drift Perps", ParentProtocol: "parent#drift"},
	}
	parents := []llamaParent{{ID: "parent#drift", Name: "Drift", GeckoID: "drift-protocol"}}

	cohort, _, _ := joinCohort(fees, nil, protocols, parents, 100_000)
	if len(cohort) != 1 {
		t.Fatalf("got %d rows, want 1", len(cohort))
	}
	if cohort[0].Category != "Derivatives" {
		t.Fatalf("category = %q, want Derivatives: 90%% of the fees are there", cohort[0].Category)
	}
}

// The floor belongs on the token. Applying it per adapter dropped every
// sub-floor product out of a multi-product token's sum, and excluded a
// token whose adapters only clear the floor together — while the
// methodology promised fees summed across every adapter.
func TestTheFeeFloorAppliesToTheTokenNotTheAdapter(t *testing.T) {
	fees := []feeAdapter{
		{Name: "Thing A", DefillamaID: "1", Category: "Dexs", Total30d: 60_000},
		{Name: "Thing B", DefillamaID: "2", Category: "Dexs", Total30d: 60_000},
		{Name: "Thing C", DefillamaID: "3", Category: "Dexs", Total30d: 60_000},
	}
	protocols := []llamaProtocol{
		{ID: float64(1), Name: "Thing A", GeckoID: "thing"},
		{ID: float64(2), Name: "Thing B", GeckoID: "thing"},
		{ID: float64(3), Name: "Thing C", GeckoID: "thing"},
	}
	cohort, st, _ := joinCohort(fees, nil, protocols, nil, 100_000)
	if len(cohort) != 1 {
		t.Fatalf("three $60k adapters on one token sum to $180k and must publish; got %d rows", len(cohort))
	}
	if cohort[0].Fees30d != 180_000 {
		t.Fatalf("fees = %v, want 180000: every adapter counts toward the sum", cohort[0].Fees30d)
	}
	if st.BelowFloor != 0 {
		t.Fatalf("BelowFloor = %d, want 0", st.BelowFloor)
	}

	// And a token that genuinely stays under the floor is still dropped,
	// and counted so the cohort's shape stays visible.
	small := []feeAdapter{{Name: "Dust", DefillamaID: "9", Category: "Dexs", Total30d: 10_000}}
	smallProt := []llamaProtocol{{ID: float64(9), Name: "Dust", GeckoID: "dust"}}
	out, st2, _ := joinCohort(small, nil, smallProt, nil, 100_000)
	if len(out) != 0 || st2.BelowFloor != 1 {
		t.Fatalf("got %d rows, BelowFloor=%d; want 0 / 1", len(out), st2.BelowFloor)
	}
}

// A token whose products are evenly matched must not flip category between
// polls: a label that oscillates moves its row between peer groups and
// moves both medians with it.
func TestAnEvenSplitPicksAStableCategory(t *testing.T) {
	fees := []feeAdapter{
		{Name: "X A", DefillamaID: "1", Category: "Lending", Total30d: 500_000},
		{Name: "X B", DefillamaID: "2", Category: "Dexs", Total30d: 500_000},
	}
	protocols := []llamaProtocol{
		{ID: float64(1), Name: "X A", GeckoID: "x"},
		{ID: float64(2), Name: "X B", GeckoID: "x"},
	}
	first, _, _ := joinCohort(fees, nil, protocols, nil, 1)
	// Same input, adapters in the other order.
	rev := []feeAdapter{fees[1], fees[0]}
	second, _, _ := joinCohort(rev, nil, protocols, nil, 1)
	if first[0].Category != second[0].Category {
		t.Fatalf("category flipped with input order: %q vs %q", first[0].Category, second[0].Category)
	}
}

// A token whose largest fee adapter went silent upstream publishes a P/F
// built on a fraction of its revenue. DeFiLlama's Drift Trade adapter
// reports $0 over 30 days after $11.1M over the year, so only Drift's
// $1.2M staking product reaches the token: its whole market cap divided by
// a tenth of its fees read as the cheapest thing in its peer group.
func TestASilentAdapterMarksTheTokenIncomplete(t *testing.T) {
	fees := []feeAdapter{
		{Name: "Drift Trade", DefillamaID: "1", ParentProtocol: "parent#drift", Category: "Derivatives", Total30d: 0, Total1y: 11_095_038},
		{Name: "Drift Staked SOL", DefillamaID: "2", ParentProtocol: "parent#drift", Category: "Liquid Staking", Total30d: 1_206_437, Total1y: 14_000_000},
	}
	protocols := []llamaProtocol{
		{ID: float64(1), Name: "Drift Trade", ParentProtocol: "parent#drift"},
		{ID: float64(2), Name: "Drift Staked SOL", ParentProtocol: "parent#drift"},
	}
	parents := []llamaParent{{ID: "parent#drift", Name: "Drift", GeckoID: "drift-protocol"}}

	cohort, st, _ := joinCohort(fees, nil, protocols, parents, 100_000)
	if len(cohort) != 1 || !cohort[0].Incomplete {
		t.Fatalf("expected one incomplete row, got %+v", cohort)
	}
	if cohort[0].SilentFees1y != 11_095_038 {
		t.Fatalf("silent 1y = %v, want 11095038: the size of the gap has to be visible",
			cohort[0].SilentFees1y)
	}
	if st.Incomplete != 1 {
		t.Fatalf("stats Incomplete = %d, want 1", st.Incomplete)
	}
}

// An incomplete row keeps its gauges but must not set the yardstick its
// peers are measured against, nor fire the screen.
func TestAnIncompleteRowLeavesTheMedianAndTheScreen(t *testing.T) {
	mk := func(slug string, mcap float64, incomplete bool) Protocol {
		return Protocol{Slug: slug, GeckoID: slug, Category: "Dexs", Fees30d: 1e6, Prev30d: 5e5, Incomplete: incomplete}
	}
	cohort := []Protocol{
		mk("a", 10e6, false), mk("b", 20e6, false), mk("c", 30e6, false),
		mk("d", 40e6, false), mk("e", 50e6, false),
		// Same fees, a tenth of the market cap: it would be the cheapest
		// row and would drag the median down with it.
		mk("broken", 1e6, true),
	}
	markets := map[string]cgMarket{}
	for i, p := range cohort {
		markets[p.GeckoID] = cgMarket{Mcap: float64(i+1) * 10e6, Circ: 90, Total: 100}
	}
	markets["broken"] = cgMarket{Mcap: 1e6, Circ: 90, Total: 100}

	rows := buildRows(cohort, markets, 10, 0)
	medians := CategoryMedians(rows)
	withBroken := median([]float64{})
	_ = withBroken

	var broken Row
	vals := []float64{}
	for _, r := range rows {
		if r.Slug == "broken" {
			broken = r
		} else if r.HasPF {
			vals = append(vals, r.PF)
		}
	}
	if broken.Slug == "" {
		t.Fatal("the incomplete row was dropped; it should still publish")
	}
	if broken.Diverging() {
		t.Error("an incomplete row fired the screen")
	}
	if got, want := medians["Dexs"], median(vals); got != want {
		t.Errorf("median %v includes the incomplete row (want %v over the other five)", got, want)
	}
}

// A token worth a few hundred thousand dollars against millions of annual
// fees prints a ratio near zero and leads an ascending board. The floor is
// what keeps the top of the board readable (audit 2026-09-25).
func TestMarketCapFloorDropsTheRow(t *testing.T) {
	cohort := []Protocol{
		{GeckoID: "dust", Name: "Dust", Category: "Dexs", Fees30d: 5_000_000},
		{GeckoID: "real", Name: "Real", Category: "Dexs", Fees30d: 5_000_000},
	}
	markets := map[string]cgMarket{
		"dust": {ID: "dust", Mcap: 400_000, FDV: 400_000, Circ: 1, Total: 1},
		"real": {ID: "real", Mcap: 200_000_000, FDV: 200_000_000, Circ: 1, Total: 1},
	}
	rows := buildRows(cohort, markets, 10, 5_000_000)
	if len(rows) != 1 || rows[0].GeckoID != "real" {
		t.Fatalf("want only the real market cap, got %+v", rows)
	}
	if got := buildRows(cohort, markets, 10, 0); len(got) != 2 {
		t.Fatalf("a zero floor keeps both rows, got %d", len(got))
	}
}

// DeFiLlama merged a Convex adapter change on 2026-08-18 that started
// booking the LP leg in dailyFees without backfilling, so a 30-day window
// straddling it printed +92% on a business that grew 15%. The trend is
// withheld when the fee line and the revenue line move apart, whatever
// share of its fees the protocol keeps (audit 2026-09-26).
func TestFeeBasisShiftWithholdsTheTrend(t *testing.T) {
	// Convex: fees x1.86, revenue x1.08.
	shifted := []Protocol{{
		GeckoID: "convex", Name: "Convex", Category: "Yield",
		Fees30d: 2_332_159, Prev30d: 1_252_104, Fees1y: 30_000_000,
		Rev30d: 929_108, RevPrev30d: 861_944, RevKnown: true,
	}}
	// A token keeping a tenth of its fees, fee line doubled by a rewrite
	// while revenue is flat: five points of share, which an absolute test
	// on the take rate would miss entirely.
	thin := []Protocol{{
		GeckoID: "thin", Name: "Thin", Category: "Yield",
		Fees30d: 4_000_000, Prev30d: 2_000_000, Fees1y: 40_000_000,
		Rev30d: 200_000, RevPrev30d: 200_000, RevKnown: true,
	}}
	// Both lines doubling together is a business that grew.
	steady := []Protocol{{
		GeckoID: "steady", Name: "Steady", Category: "Yield",
		Fees30d: 2_000_000, Prev30d: 1_000_000, Fees1y: 30_000_000,
		Rev30d: 1_000_000, RevPrev30d: 500_000, RevKnown: true,
	}}
	markets := map[string]cgMarket{
		"convex": {ID: "convex", Mcap: 193e6, FDV: 205e6, Circ: 93, Total: 100},
		"thin":   {ID: "thin", Mcap: 193e6, FDV: 205e6, Circ: 93, Total: 100},
		"steady": {ID: "steady", Mcap: 193e6, FDV: 205e6, Circ: 93, Total: 100},
	}
	for _, c := range []struct {
		name string
		in   []Protocol
		want bool
	}{{"convex", shifted, true}, {"thin", thin, true}, {"steady", steady, false}} {
		markFeeBasisShift(&c.in[0])
		if c.in[0].FeeBasisShift != c.want {
			t.Fatalf("%s: flag %v, want %v", c.name, c.in[0].FeeBasisShift, c.want)
		}
		rows := buildRows(c.in, markets, 10, 0)
		if len(rows) != 1 {
			t.Fatalf("%s: want one row, got %d", c.name, len(rows))
		}
		if rows[0].HasFeeGrowth == c.want {
			t.Fatalf("%s: trend published %v with the flag at %v", c.name, rows[0].HasFeeGrowth, c.want)
		}
	}
}

// The seam outlives the tick that finds it: it sits in the prior window
// for another month, inflating the comparison, while the detection itself
// fades as that window fills with the new basis. The memory is what keeps
// the trend withheld through that (review of PR 2695).
func TestFeeBasisMemoryOutlivesTheDetection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "fee-basis.json")
	day0 := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)

	detected := []Protocol{{GeckoID: "convex", FeeBasisShift: true}}
	if n := newFeeBasisMemory(path).apply(detected, day0); n != 1 {
		t.Fatalf("the tick that detects it flags it, got %d", n)
	}

	// Ten days later the ratio has settled back inside the bound, so this
	// tick detects nothing. A fresh store reads the file and still holds.
	settled := []Protocol{{GeckoID: "convex"}}
	if n := newFeeBasisMemory(path).apply(settled, day0.Add(10*24*time.Hour)); n != 1 {
		t.Fatalf("a remembered shift keeps the trend withheld, got %d", n)
	}
	if !settled[0].FeeBasisShift {
		t.Fatal("the row should carry the remembered flag")
	}

	// Past the window it is forgotten, and the file no longer names it.
	late := []Protocol{{GeckoID: "convex"}}
	if n := newFeeBasisMemory(path).apply(late, day0.Add(40*24*time.Hour)); n != 0 {
		t.Fatalf("the memory expires, got %d", n)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if strings.Contains(string(b), "convex") {
		t.Fatalf("an expired entry is pruned, file is %s", b)
	}

	// No path: the harness still runs, it just forgets on restart.
	mem := newFeeBasisMemory("")
	if n := mem.apply([]Protocol{{GeckoID: "x", FeeBasisShift: true}}, day0); n != 1 {
		t.Fatalf("an in-process memory still flags, got %d", n)
	}
}
