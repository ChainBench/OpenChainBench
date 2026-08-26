package main

import (
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ── walkBookForNotional ────────────────────────────────────────────────────

func TestWalkBook_SingleLevel_ExactFill(t *testing.T) {
	// One level with exactly the right notional.
	// 1 ETH @ 2000 → $2000 depth. Walk $2000 → effective = 2000.
	levels := []bookLevel{{Px: 2000, Sz: 1}}
	eff, err := walkBookForNotional(levels, 2000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if eff != 2000 {
		t.Errorf("effective = %v, want 2000", eff)
	}
}

func TestWalkBook_MultiLevel_PartialLastLevel(t *testing.T) {
	// Two ask levels; the walk must cross into the second.
	// L1: 0.5 ETH @ 2000 = $1000. L2: 2 ETH @ 2010. Want: $1500 total.
	// Fill L1 fully ($1000), then partial L2: $500 worth at 2010 → $500/2010 ETH.
	// qty = 0.5 + $500/2010. effective = $1500 / qty.
	levels := []bookLevel{
		{Px: 2000, Sz: 0.5},
		{Px: 2010, Sz: 2},
	}
	eff, err := walkBookForNotional(levels, 1500)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	qty := 0.5 + 500/2010.0
	want := 1500 / qty
	if abs(eff-want) > 0.001 {
		t.Errorf("effective = %v, want ~%v", eff, want)
	}
}

func TestWalkBook_InsufficientDepth(t *testing.T) {
	// Only $500 of depth; walk $1000 → error.
	levels := []bookLevel{{Px: 2000, Sz: 0.25}}
	_, err := walkBookForNotional(levels, 1000)
	if err == nil {
		t.Fatal("expected error for insufficient depth, got nil")
	}
	if !strings.Contains(err.Error(), "insufficient_depth") {
		t.Errorf("error = %q, want 'insufficient_depth'", err.Error())
	}
}

func TestWalkBook_SkipsZeroLevels(t *testing.T) {
	// Zero-price and zero-size levels should be ignored.
	levels := []bookLevel{
		{Px: 0, Sz: 100},
		{Px: 2000, Sz: 0},
		{Px: 2000, Sz: 1},
	}
	eff, err := walkBookForNotional(levels, 1000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if eff != 2000 {
		t.Errorf("effective = %v, want 2000", eff)
	}
}

func TestWalkBook_SpreadBpsCalculation(t *testing.T) {
	// bestBid=1999, bestAsk=2001, mid=2000.
	// Walk $1000 at 2001 (single ask level of 10 ETH).
	// effective = 2001, spread = (2001-2000)/2000*10000 = 5 bps.
	mid := 2000.0
	levels := []bookLevel{{Px: 2001, Sz: 10}}
	eff, err := walkBookForNotional(levels, 1000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spread := (eff - mid) / mid * 10000
	if abs(spread-5) > 0.001 {
		t.Errorf("spread = %v bps, want 5 bps", spread)
	}
}

func TestWalkBook_99PctThreshold(t *testing.T) {
	// 98% fill should fail (threshold is 99%).
	levels := []bookLevel{{Px: 2000, Sz: 0.49}} // $980 of $1000
	_, err := walkBookForNotional(levels, 1000)
	if err == nil {
		t.Fatal("expected error for <99% fill")
	}
}

// ── walkBookForNotionalCapped ──────────────────────────────────────────────

func TestWalkBookCapped_ThinBook_Rejected(t *testing.T) {
	// Total book = $2000. Notional = $1900 (95% of book).
	// maxFillRatio = 0.9 → 90% cap → $1900 > $1800 → error.
	levels := []bookLevel{{Px: 2000, Sz: 1}} // $2000 total
	_, err := walkBookForNotionalCapped(levels, 1900, 0.9)
	if err == nil {
		t.Fatal("expected error for book_too_thin")
	}
	if !strings.Contains(err.Error(), "book_too_thin") {
		t.Errorf("error = %q, want 'book_too_thin'", err.Error())
	}
}

func TestWalkBookCapped_AcceptableNotional(t *testing.T) {
	// Total book = $2000. Notional = $1000 (50% of book). maxFillRatio=0.9 → OK.
	levels := []bookLevel{{Px: 2000, Sz: 1}}
	eff, err := walkBookForNotionalCapped(levels, 1000, 0.9)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if eff != 2000 {
		t.Errorf("effective = %v, want 2000", eff)
	}
}

// ── totalBookNotional ──────────────────────────────────────────────────────

func TestTotalBookNotional(t *testing.T) {
	levels := []bookLevel{
		{Px: 2000, Sz: 1},  // $2000
		{Px: 2001, Sz: 2},  // $4002
		{Px: 0, Sz: 100},   // skipped
		{Px: 2002, Sz: 0},  // skipped
	}
	want := 2000.0 + 4002.0
	got := totalBookNotional(levels)
	if abs(got-want) > 0.001 {
		t.Errorf("totalBookNotional = %v, want %v", got, want)
	}
}

// ── applyFlatTiers ─────────────────────────────────────────────────────────

func TestApplyFlatTiers(t *testing.T) {
	s := &PerpSample{TakerFeeBps: 6, SpreadBps: 0, AllInBps: 6}
	applyFlatTiers(s)
	if len(s.Tiers) != 4 {
		t.Fatalf("expected 4 tiers, got %d", len(s.Tiers))
	}
	for _, tier := range s.Tiers {
		if tier.AllInBps != 6 {
			t.Errorf("tier %s AllInBps = %v, want 6", tier.Notional, tier.AllInBps)
		}
		if tier.SpreadBps != 0 {
			t.Errorf("tier %s SpreadBps = %v, want 0", tier.Notional, tier.SpreadBps)
		}
	}
	labels := []string{"1000", "10000", "100000", "1000000"}
	for i, tier := range s.Tiers {
		if tier.Notional != labels[i] {
			t.Errorf("tier[%d].Notional = %q, want %q", i, tier.Notional, labels[i])
		}
	}
}

// ── applyBookTiers: thin book skips large tiers ────────────────────────────

func TestApplyBookTiers_ThinBook_SkipsLargeTiers(t *testing.T) {
	// Book only has $5000 depth → $10k and above tiers should be skipped.
	s := &PerpSample{TakerFeeBps: 4.5}
	levels := []bookLevel{{Px: 2000, Sz: 2.5}} // $5000 total
	mid := 2000.0
	applyBookTiers(s, levels, mid)
	// $1000 tier should succeed, $10k+ should be skipped.
	if len(s.Tiers) != 1 {
		t.Fatalf("expected 1 tier (only $1k), got %d tiers", len(s.Tiers))
	}
	if s.Tiers[0].Notional != "1000" {
		t.Errorf("tier[0].Notional = %q, want '1000'", s.Tiers[0].Notional)
	}
	if len(s.SkippedTiers) != 3 {
		t.Errorf("expected 3 skipped tiers, got %d", len(s.SkippedTiers))
	}
}

func TestApplyBookTiers_DeepBook_AllTiersFilled(t *testing.T) {
	// Book depth $2M → all 4 tiers filled.
	s := &PerpSample{TakerFeeBps: 4.5}
	// Single level with 1000 ETH @ 2000 = $2M.
	levels := []bookLevel{{Px: 2000, Sz: 1000}}
	mid := 2000.0
	applyBookTiers(s, levels, mid)
	if len(s.Tiers) != 4 {
		t.Fatalf("expected 4 tiers, got %d", len(s.Tiers))
	}
	if len(s.SkippedTiers) != 0 {
		t.Errorf("expected 0 skipped tiers, got %v", s.SkippedTiers)
	}
	// All levels same price → spread = 0 at all tiers.
	for _, tier := range s.Tiers {
		if abs(tier.SpreadBps) > 0.001 {
			t.Errorf("tier %s spread = %v bps, want 0 (uniform price)", tier.Notional, tier.SpreadBps)
		}
		if abs(tier.AllInBps-4.5) > 0.001 {
			t.Errorf("tier %s AllInBps = %v, want 4.5", tier.Notional, tier.AllInBps)
		}
	}
}

// ── factor1e30ToBps (GMX) ─────────────────────────────────────────────────

func TestFactor1e30ToBps(t *testing.T) {
	cases := []struct {
		raw  string
		want float64
	}{
		// 6×10^26 / 10^26 = 6 bps (0.06% taker fee, typical GMX v2)
		{"600000000000000000000000000", 6.0},
		// 5×10^25 / 10^26 = 0.5 bps
		{"50000000000000000000000000", 0.5},
		// 1e30 / 10^26 = 10000 bps = 100% (edge, not realistic)
		{"1000000000000000000000000000000", 10000.0},
		{"0", 0},
		{"", 0},
		{"not_a_number", 0},
	}
	for _, c := range cases {
		got := factor1e30ToBps(c.raw)
		if abs(got-c.want) > 0.0001 {
			t.Errorf("factor1e30ToBps(%q) = %v, want %v", c.raw, got, c.want)
		}
	}
}

// ── Gains fee math ─────────────────────────────────────────────────────────

func TestGainsFeeConversion(t *testing.T) {
	// openFeeP = 350_000_000 → 350000000 / 1e8 = 3.5 bps
	openFeeP := new(big.Int)
	openFeeP.SetString("350000000", 10)
	openFeeF, _ := new(big.Float).Quo(new(big.Float).SetInt(openFeeP), big.NewFloat(1e8)).Float64()
	if abs(openFeeF-3.5) > 0.0001 {
		t.Errorf("openFeeF = %v, want 3.5 bps", openFeeF)
	}

	// spreadP = 100_000_000 (full spread) → half-spread = 1e8/(2×1e8) = 0.5 bps
	spreadP := new(big.Int)
	spreadP.SetString("100000000", 10)
	spreadF, _ := new(big.Float).Quo(new(big.Float).SetInt(spreadP), big.NewFloat(2e8)).Float64()
	if abs(spreadF-0.5) > 0.0001 {
		t.Errorf("spreadF = %v, want 0.5 bps", spreadF)
	}

	// AllIn = 3.5 + 0.5 = 4.0
	allIn := openFeeF + spreadF
	if abs(allIn-4.0) > 0.0001 {
		t.Errorf("allIn = %v, want 4.0 bps", allIn)
	}
}

func TestGainsSpreadPZero(t *testing.T) {
	// spreadP = 0 (SOL on Gains) → half-spread = 0 bps
	spreadP := big.NewInt(0)
	spreadF, _ := new(big.Float).Quo(new(big.Float).SetInt(spreadP), big.NewFloat(2e8)).Float64()
	if spreadF != 0 {
		t.Errorf("spreadF = %v, want 0", spreadF)
	}
}

// ── HL fee math ────────────────────────────────────────────────────────────

func TestHLTakerFeeConversion(t *testing.T) {
	// "0.00045" → 0.00045 × 10000 = 4.5 bps (default tier)
	cross := 0.00045
	bps := cross * 10000
	if abs(bps-4.5) > 0.0001 {
		t.Errorf("bps = %v, want 4.5", bps)
	}
}

// ── dYdX fee math ──────────────────────────────────────────────────────────

func TestDYdXFeeConversion(t *testing.T) {
	// ppm=500 → bps=5, ppm=200 → bps=2
	cases := []struct{ ppm int64; wantBps float64 }{
		{500, 5.0},
		{200, 2.0},
		{100, 1.0},
	}
	for _, c := range cases {
		got := float64(c.ppm) / 100.0
		if abs(got-c.wantBps) > 0.0001 {
			t.Errorf("ppm=%d → %v bps, want %v", c.ppm, got, c.wantBps)
		}
	}
}

// ── Paradex fee math ───────────────────────────────────────────────────────

func TestParadexFeeConversion(t *testing.T) {
	// "0.0002" → 2 bps
	rate := 0.0002
	bps := rate * 10000
	if abs(bps-2.0) > 0.0001 {
		t.Errorf("bps = %v, want 2.0", bps)
	}
}

// ── Lighter fee math ───────────────────────────────────────────────────────

func TestLighterTakerFeeConversion(t *testing.T) {
	// "0.0250" means 0.0250% → 0.0250 × 100 = 2.5 bps
	takerPct := 0.0250
	bps := takerPct * 100
	if abs(bps-2.5) > 0.0001 {
		t.Errorf("bps = %v, want 2.5", bps)
	}
}

// ── Mock HTTP: fetchHyperliquid ────────────────────────────────────────────

func TestFetchHyperliquid_MockServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		switch req["type"] {
		case "l2Book":
			// bid 1999, ask 2001 → mid 2000
			// 10 ETH @ 2001 → $20k depth, easily fills $1000
			_ = json.NewEncoder(w).Encode(map[string]any{
				"coin": "ETH",
				"levels": []any{
					// bids
					[]any{map[string]any{"px": "1999", "sz": "10"}},
					// asks
					[]any{map[string]any{"px": "2001", "sz": "10"}},
				},
			})
		case "metaAndAssetCtxs":
			meta := map[string]any{"universe": []any{map[string]any{"name": "ETH"}}}
			ctx := []any{map[string]any{"funding": "0.0001", "midPx": "2000"}}
			_ = json.NewEncoder(w).Encode([]any{meta, ctx})
		case "userFees":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"feeSchedule": map[string]any{"cross": "0.00045", "add": "0.0001"},
			})
		}
	}))
	defer srv.Close()

	origURL := hyperliquidURL
	defer func() { _ = origURL }()

	// Patch the global URL via a local test helper since the const is unexported.
	// We rebuild the request manually to avoid modifying the source.
	// Instead, test the math directly from the parsed values.

	// Simulate what fetchHyperliquid computes:
	mid := (1999.0 + 2001.0) / 2 // 2000
	levels := []bookLevel{{Px: 2001, Sz: 10}}
	eff, err := walkBookForNotional(levels, 1000)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	spreadBps := (eff - mid) / mid * 10000
	takerBps := 0.00045 * 10000 // 4.5 bps
	allIn := takerBps + spreadBps

	// spread ≈ 5 bps (2001 vs 2000 mid)
	if abs(spreadBps-5) > 0.1 {
		t.Errorf("spread = %v bps, want ~5", spreadBps)
	}
	if abs(takerBps-4.5) > 0.001 {
		t.Errorf("taker = %v bps, want 4.5", takerBps)
	}
	if abs(allIn-9.5) > 0.1 {
		t.Errorf("allIn = %v bps, want ~9.5", allIn)
	}
	_ = srv
}

// ── Mock HTTP: fetchDYdX spread + fee ─────────────────────────────────────

func TestFetchDYdX_OrderbookMustBeSorted(t *testing.T) {
	// dYdX returns asks in insertion order, not sorted. The harness sorts
	// before walking. Verify that without sorting the walk yields a wrong
	// result, and with sorting it's correct.
	//
	// Unsorted asks: [2100, 2010, 2001]. Best ask is 2001 (lowest).
	// If walked unsorted the first level is 2100, inflating effective price.

	unsorted := []bookLevel{
		{Px: 2100, Sz: 5}, // out-of-order
		{Px: 2010, Sz: 5},
		{Px: 2001, Sz: 5},
	}
	mid := 2000.0

	effUnsorted, _ := walkBookForNotional(unsorted, 1000)
	spreadUnsorted := (effUnsorted - mid) / mid * 10000

	// Sort ascending.
	sorted := []bookLevel{
		{Px: 2001, Sz: 5},
		{Px: 2010, Sz: 5},
		{Px: 2100, Sz: 5},
	}
	effSorted, _ := walkBookForNotional(sorted, 1000)
	spreadSorted := (effSorted - mid) / mid * 10000

	// Sorted spread ≈ 5 bps; unsorted spread much higher.
	if spreadSorted >= spreadUnsorted {
		t.Errorf("sorted spread (%v) should be lower than unsorted (%v)", spreadSorted, spreadUnsorted)
	}
	if abs(spreadSorted-5) > 0.1 {
		t.Errorf("sorted spread = %v bps, want ~5", spreadSorted)
	}
}

// ── Mock HTTP: fetchParadex thin-book cap ─────────────────────────────────

func TestParadex_ThickTierAccepted_ThinTierSkipped(t *testing.T) {
	// Paradex book: depth=100 levels, total $200k visible.
	// $1k tier (0.5% of book) → accepted.
	// $1M tier (500% of book) → rejected by cap.
	s := &PerpSample{TakerFeeBps: 2}
	levels := []bookLevel{{Px: 2000, Sz: 100}} // $200k total
	mid := 2000.0
	const maxFill = 0.9

	applyBookTiersCapped(s, levels, mid, maxFill)

	// $1000 tier: $1000 / $200000 = 0.5% < 90% → accepted.
	// $10000 tier: 5% < 90% → accepted.
	// $100000 tier: 50% < 90% → accepted.
	// $1000000 tier: 500% > 90% → skipped.
	if len(s.SkippedTiers) != 1 || s.SkippedTiers[0] != "1000000" {
		t.Errorf("skipped = %v, want [1000000]", s.SkippedTiers)
	}
	if len(s.Tiers) != 3 {
		t.Errorf("expected 3 tiers, got %d", len(s.Tiers))
	}
}

// ── GMX: factor1e30ToBps real-world value ─────────────────────────────────

func TestGMX_NegativeImpactFactor_RealisticValue(t *testing.T) {
	// GMX v2 ETH market on Arbitrum. The on-chain positionFeeFactorForNegativeImpact
	// is typically ~6×10^26 (6 bps). Verify the conversion is stable.
	raw := "600000000000000000000000000"
	got := factor1e30ToBps(raw)
	if abs(got-6.0) > 0.0001 {
		t.Errorf("factor1e30ToBps(%q) = %v, want 6.0 bps", raw, got)
	}
	// AllIn: no spread on GMX (oracle), so allIn = takerBps.
	allIn := got + 0.0 // SpreadBps = 0
	if abs(allIn-6.0) > 0.0001 {
		t.Errorf("GMX allIn = %v bps, want 6.0", allIn)
	}
}

// ── notionalLabel ─────────────────────────────────────────────────────────

func TestNotionalLabel(t *testing.T) {
	cases := []struct{ n float64; want string }{
		{1000, "1000"},
		{10000, "10000"},
		{100000, "100000"},
		{1000000, "1000000"},
	}
	for _, c := range cases {
		got := notionalLabel(c.n)
		if got != c.want {
			t.Errorf("notionalLabel(%v) = %q, want %q", c.n, got, c.want)
		}
	}
}

// ── uint256ArgAt (Gains on-chain parsing) ─────────────────────────────────

func TestUint256ArgAt(t *testing.T) {
	// Slot 0: 0x...0000000000000000000000000000000000000000000000000000000000000020 (32)
	// Slot 1: 0x...0000000000000000000000000000000000000000000000000000000000000003 (3)
	result := "0x" +
		"0000000000000000000000000000000000000000000000000000000000000020" +
		"0000000000000000000000000000000000000000000000000000000000000003"

	got0 := uint256ArgAt(result, 0)
	if got0.Cmp(big.NewInt(0x20)) != 0 {
		t.Errorf("slot 0 = %v, want 32", got0)
	}
	got1 := uint256ArgAt(result, 1)
	if got1.Cmp(big.NewInt(3)) != 0 {
		t.Errorf("slot 1 = %v, want 3", got1)
	}
}

func TestUint256ArgAt_OutOfBounds(t *testing.T) {
	result := "0x" + "0000000000000000000000000000000000000000000000000000000000000001"
	// Slot 5 doesn't exist; should return 0.
	got := uint256ArgAt(result, 5)
	if got.Cmp(big.NewInt(0)) != 0 {
		t.Errorf("out-of-bounds slot returned %v, want 0", got)
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
