package main

import (
	"encoding/json"
	"math"
	"math/big"
	"os"
	"testing"
)

// Fixtures captured live on 2026-10-12.
//
//	pair 0   BTC/USD    getPairLiquidationParams -> stdLiqParams
//	pair 300 BTCDEGEN   getPairLiquidationParams -> degenLiqParams
//
// Pair 0 is the calibration fixture: Gains documents a 90 percent liquidation
// threshold on its standard pairs, so a scale that does not turn word 1 into 90
// is the wrong scale. The hex is generated from the word integers rather than
// retyped, because retyping it is how a digit per word went missing once and
// an 80 percent threshold read as 0.3125.
const (
	stdLiqParams   = "0x000000000000000000000000000000000000000000000000000000001dcd6500000000000000000000000000000000000000000000000000000000d18c2e2800000000000000000000000000000000000000000000000000000000ae9f7bcc0000000000000000000000000000000000000000000000000000000000000061a8000000000000000000000000000000000000000000000000000000000000ea60"
	degenLiqParams = "0x000000000000000000000000000000000000000000000000000000001dcd6500000000000000000000000000000000000000000000000000000000ba43b74000000000000000000000000000000000000000000000000000000000ba43b74000000000000000000000000000000000000000000000000000000000000007a120000000000000000000000000000000000000000000000000000000000007a120"
)

// Papertrade instrument tuples, captured live on 2026-10-12.
const (
	ptBTCInstrument = `[0, "BTC", 0, "10", true, false, false, false, false, null, null, null, "15000000000000000000000", "814598000000000000000", 1000, "10000000000000000000000000", "476041580087574", "100000000000000000"]`
	ptETHInstrument = `[1, "ETH", 1, "100", true, false, false, false, false, null, null, null, "15000000000000000000000", "483979000000000000000", 1000, "10000000000000000000000000", "481304050180130", "100000000000000000"]`
)

func approx(t *testing.T, label string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %.6f, want %.6f (tol %g)", label, got, want, tol)
	}
}

func words(t *testing.T, hexStr string) []*big.Int {
	t.Helper()
	w, err := decodeWordsHex(hexStr)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	return w
}

func ptTuple(t *testing.T, raw string) []json.RawMessage {
	t.Helper()
	var out []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	return out
}

// gainsVenue builds the venueTerms fetchGains would build from a decoded
// return, so the tests exercise the same closure the harness publishes from.
func gainsVenue(t *testing.T, hexStr string, maxLev float64) venueTerms {
	t.Helper()
	w := words(t, hexStr)
	if len(w) != 5 {
		t.Fatalf("got %d words, want 5", len(w))
	}
	startTh := bigToFloat(w[1], 1e10)
	endTh := bigToFloat(w[2], 1e10)
	startLev := bigToFloat(w[3], 1e3)
	endLev := bigToFloat(w[4], 1e3)
	return venueTerms{
		venue: "gains", market: "BTC", maxLev: maxLev,
		maintenance: func(lev float64) float64 {
			return (100 - interpolateThreshold(startTh, endTh, startLev, endLev, lev)) / 100 / lev
		},
	}
}

// TestGainsScaleCalibration is the anchor: the standard pair must read as the
// documented 90 percent, which fixes the 1e10 scale for every other pair.
func TestGainsScaleCalibration(t *testing.T) {
	w := words(t, stdLiqParams)
	if len(w) != 5 {
		t.Fatalf("got %d words, want 5", len(w))
	}
	approx(t, "maxLiqSpreadP", bigToFloat(w[0], 1e10), 0.05, 1e-9)
	approx(t, "startLiqThresholdP", bigToFloat(w[1], 1e10), 90, 1e-9)
	approx(t, "endLiqThresholdP", bigToFloat(w[2], 1e10), 75, 1e-9)
	approx(t, "startLeverage", bigToFloat(w[3], 1e3), 25, 1e-9)
	approx(t, "endLeverage", bigToFloat(w[4], 1e3), 60, 1e-9)
}

// TestGainsThresholdInterpolates pins the piecewise shape of
// getLiqPnlThresholdP: flat below startLeverage, flat above endLeverage, linear
// between. A degen pair sets both bounds equal, which is the flat case, so
// without the standard pair this behaviour would never be exercised.
func TestGainsThresholdInterpolates(t *testing.T) {
	const startTh, endTh, startLev, endLev = 90, 75, 25, 60
	for _, c := range []struct{ lev, want float64 }{
		{2, 90},       // below the floor
		{25, 90},      // at the floor
		{60, 75},      // at the ceiling
		{150, 75},     // above the ceiling
		{42.5, 82.5},  // the midpoint is the mean of the two thresholds
		{40, 83.5714}, // an arbitrary interior point
	} {
		got := interpolateThreshold(startTh, endTh, startLev, endLev, c.lev)
		approx(t, "threshold at leverage", got, c.want, 1e-4)
	}
}

// TestGainsRoomScalesWithLeverage: because the threshold is a share of
// collateral and is flat on a degen pair, the room falls in exact proportion to
// leverage while the share returned never moves. That is the property the bench
// contrasts Papertrade against.
func TestGainsRoomScalesWithLeverage(t *testing.T) {
	g := gainsVenue(t, degenLiqParams, 500)
	for _, c := range []struct{ lev, room, kept float64 }{
		{500, 0.16, 20}, // at the maximum
		{100, 0.8, 20},
		{50, 1.6, 20},
		{10, 8, 20},
	} {
		room, kept, ok := termsAt(g, c.lev)
		if !ok {
			t.Fatalf("gains rejected at %.0fx", c.lev)
		}
		approx(t, "gains room", room, c.room, 1e-9)
		approx(t, "gains kept", kept, c.kept, 1e-9)
	}
}

// TestPapertradeBufferIsAnOffsetNotTheRoom is the test that exists because the
// first version of this source got it backwards. Papertrade's docs work the
// 1000x case themselves: "at 1000x, where your full margin covers a 0.1% move,
// liquidation fires after a move of about 0.052%". That is 1/1000 minus the
// buffer. Reading the buffer AS the room would give 0.0476 and the published
// figure would have been wrong.
func TestPapertradeBufferIsAnOffsetNotTheRoom(t *testing.T) {
	sym, lev, buffer, ok := papertradeTerms(ptTuple(t, ptBTCInstrument))
	if !ok {
		t.Fatal("BTC tuple rejected")
	}
	if sym != "BTC" {
		t.Errorf("symbol = %q, want BTC", sym)
	}
	approx(t, "max leverage", lev, 1000, 1e-9)
	// About 5 basis points of price, which is what the docs call it.
	approx(t, "buffer in percent", buffer*100, 0.0476041580087574, 1e-12)

	pt := venueTerms{venue: "papertrade", market: sym, maxLev: lev,
		maintenance: func(float64) float64 { return buffer }, forfeitsAll: true}

	room, kept, ok := termsAt(pt, 1000)
	if !ok {
		t.Fatal("rejected at 1000x")
	}
	// The docs' own worked figure, to their stated precision.
	approx(t, "room at 1000x", room, 0.052, 5e-4)
	// And not the buffer itself, which is the mistake this test guards.
	if math.Abs(room-buffer*100) < 1e-6 {
		t.Errorf("room %.6f equals the buffer, the offset was read as the room", room)
	}
	// Hard bust forfeits everything, whatever the arithmetic would return.
	approx(t, "kept at 1000x", kept, 0, 0)
}

// TestPapertradeBufferCostsMoreAsLeverageGrows: the buffer is fixed in price,
// so the share of margin it represents grows with leverage. The docs state the
// 100x case ("at 100x the buffer is about 5% of your margin") and the 1000x one
// ("nearly half your margin"), so both are checkable.
func TestPapertradeBufferCostsMoreAsLeverageGrows(t *testing.T) {
	_, lev, buffer, ok := papertradeTerms(ptTuple(t, ptBTCInstrument))
	if !ok {
		t.Fatal("rejected")
	}
	// What a voluntary close would return, which is the buffer's share of the
	// margin. Published as zero on the liquidation path, but it is the number
	// the docs quote, so it is the one to check the model against.
	approx(t, "buffer share of margin at 100x", buffer*100*100, 4.76, 1e-2)
	approx(t, "buffer share of margin at 1000x", buffer*1000*100, 47.6, 1e-1)
	if !(buffer*lev*100 > 40) {
		t.Errorf("at max leverage the buffer should eat most of the margin, got %.1f%%", buffer*lev*100)
	}

	pt := venueTerms{venue: "papertrade", maxLev: lev,
		maintenance: func(float64) float64 { return buffer }, forfeitsAll: true}
	// Room shrinks with leverage like everywhere else; it is the buffer that
	// is constant, not the room. The first version of this source had that
	// backwards and claimed the room was identical at 1x and 1000x.
	r10, _, _ := termsAt(pt, 10)
	r1000, _, _ := termsAt(pt, 1000)
	if !(r10 > r1000) {
		t.Errorf("room should shrink with leverage: 10x=%.4f 1000x=%.4f", r10, r1000)
	}
}

func TestPapertradeTermsGuardsTupleShape(t *testing.T) {
	full := ptTuple(t, ptBTCInstrument)
	if _, _, _, ok := papertradeTerms(full[:16]); ok {
		t.Error("accepted a tuple too short to hold the bust buffer")
	}
	zeroBuf := append([]json.RawMessage{}, full...)
	zeroBuf[16] = json.RawMessage(`"0"`)
	if _, _, _, ok := papertradeTerms(zeroBuf); ok {
		t.Error("accepted a zero bust buffer")
	}
	hugeBuf := append([]json.RawMessage{}, full...)
	hugeBuf[16] = json.RawMessage(`"2000000000000000000"`) // 2.0, not a share
	if _, _, _, ok := papertradeTerms(hugeBuf); ok {
		t.Error("accepted a buffer above 100 percent of price")
	}
	noSym := append([]json.RawMessage{}, full...)
	noSym[1] = json.RawMessage(`""`)
	if _, _, _, ok := papertradeTerms(noSym); ok {
		t.Error("accepted an empty symbol")
	}
	// ETH too, so the fixture pair is not just one lucky tuple.
	sym, lev, buf, ok := papertradeTerms(ptTuple(t, ptETHInstrument))
	if !ok || sym != "ETH" {
		t.Fatalf("ETH tuple: ok=%v sym=%q", ok, sym)
	}
	approx(t, "ETH max leverage", lev, 1000, 1e-9)
	approx(t, "ETH buffer percent", buf*100, 0.048130405018013, 1e-12)
}

// TestMarginFractionVenues covers dYdX, whose two fractions are published, and
// Hyperliquid, whose maintenance requirement comes from the documented halving
// rule. The trap is that the share returned is a ratio of the two fractions and
// not their difference, because the collateral posted is the initial one.
func TestMarginFractionVenues(t *testing.T) {
	// dYdX BTC-USD, read live 2026-10-12: IMF 0.02, MMF 0.012.
	dydx := venueTerms{venue: "dydx", maxLev: 1 / 0.02,
		maintenance: func(float64) float64 { return 0.012 }}
	approx(t, "dydx max leverage", dydx.maxLev, 50, 1e-9)
	for _, c := range []struct{ lev, room, kept float64 }{
		{50, 0.8, 60},
		{25, 2.8, 30},
		{10, 8.8, 12},
	} {
		room, kept, ok := termsAt(dydx, c.lev)
		if !ok {
			t.Fatalf("dydx rejected at %.0fx", c.lev)
		}
		approx(t, "dydx room", room, c.room, 1e-9)
		approx(t, "dydx kept", kept, c.kept, 1e-9)
	}

	// Hyperliquid BTC: maxLeverage 40, maintenance at half the initial
	// requirement, so the share returned is 50 percent at the maximum
	// whatever the asset.
	hl := venueTerms{venue: "hyperliquid", maxLev: 40,
		maintenance: func(float64) float64 { return 1.0 / 80 }}
	for _, c := range []struct{ lev, room, kept float64 }{
		{40, 1.25, 50},
		{10, 8.75, 12.5},
	} {
		room, kept, ok := termsAt(hl, c.lev)
		if !ok {
			t.Fatalf("hyperliquid rejected at %.0fx", c.lev)
		}
		approx(t, "hl room", room, c.room, 1e-9)
		approx(t, "hl kept", kept, c.kept, 1e-9)
	}
}

// TestTermsAtRefusesImpossible: a leverage the venue does not offer, or a
// maintenance requirement that swallows the whole margin, is refused rather
// than published. A venue that published a leverage but no room would read as
// the safest row on the board.
func TestTermsAtRefusesImpossible(t *testing.T) {
	v := venueTerms{maxLev: 40, maintenance: func(float64) float64 { return 1.0 / 80 }}
	for _, lev := range []float64{0, -10, 41, 1000} {
		if _, _, ok := termsAt(v, lev); ok {
			t.Errorf("accepted leverage %.0f on a 40x venue", lev)
		}
	}
	// Maintenance at or above 1/L: liquidated before it opens.
	tight := venueTerms{maxLev: 100, maintenance: func(float64) float64 { return 0.02 }}
	if _, _, ok := termsAt(tight, 100); ok {
		t.Error("accepted a maintenance requirement above the margin posted")
	}
	if _, _, ok := termsAt(venueTerms{maxLev: 10, maintenance: func(float64) float64 { return 0 }}, 10); ok {
		t.Error("accepted a zero maintenance requirement")
	}
}

// TestRankingInvertsWithLeverage is the finding the leverage selector exists
// for, and the reason the bench cannot be published at max leverage alone.
//
// At each venue's OWN maximum, Papertrade has the least room of the four. At a
// leverage they all offer, it has the MOST, because its buffer is five basis
// points while the others hold back more than a percent. The ranking inverts,
// and only the collateral column stays damning throughout.
func TestRankingInvertsWithLeverage(t *testing.T) {
	_, ptLev, buffer, ok := papertradeTerms(ptTuple(t, ptBTCInstrument))
	if !ok {
		t.Fatal("papertrade rejected")
	}
	pt := venueTerms{venue: "papertrade", maxLev: ptLev,
		maintenance: func(float64) float64 { return buffer }, forfeitsAll: true}
	gains := gainsVenue(t, degenLiqParams, 500)
	dydx := venueTerms{venue: "dydx", maxLev: 50, maintenance: func(float64) float64 { return 0.012 }}
	hl := venueTerms{venue: "hyperliquid", maxLev: 40, maintenance: func(float64) float64 { return 1.0 / 80 }}

	// At each venue's own maximum: more leverage, less room, monotonically.
	ptMax, _, _ := termsAt(pt, pt.maxLev)
	gMax, gKeptMax, _ := termsAt(gains, gains.maxLev)
	dMax, dKeptMax, _ := termsAt(dydx, dydx.maxLev)
	hMax, hKeptMax, _ := termsAt(hl, hl.maxLev)
	if !(ptMax < gMax && gMax < dMax && dMax < hMax) {
		t.Errorf("at max leverage the room should shrink as leverage grows: pt=%.4f gains=%.4f dydx=%.4f hl=%.4f",
			ptMax, gMax, dMax, hMax)
	}

	// At 10x, which all four offer, the order reverses for Papertrade.
	pt10, pt10Kept, _ := termsAt(pt, 10)
	g10, _, _ := termsAt(gains, 10)
	d10, _, _ := termsAt(dydx, 10)
	h10, _, _ := termsAt(hl, 10)
	if !(pt10 > d10 && pt10 > h10 && pt10 > g10) {
		t.Errorf("at 10x papertrade should have the most room: pt=%.4f gains=%.4f dydx=%.4f hl=%.4f",
			pt10, g10, d10, h10)
	}
	if !(g10 < d10 && g10 < h10) {
		t.Errorf("at 10x gains should have the least room, it liquidates at 80%% of collateral at any leverage: gains=%.4f dydx=%.4f hl=%.4f",
			g10, d10, h10)
	}
	// The collateral column does not invert: Papertrade returns nothing at
	// every leverage, and the other three always return something.
	approx(t, "papertrade kept at 10x", pt10Kept, 0, 0)
	for name, kept := range map[string]float64{"gains": gKeptMax, "dydx": dKeptMax, "hyperliquid": hKeptMax} {
		if kept <= 0 {
			t.Errorf("%s should return collateral, got %.2f", name, kept)
		}
	}
}

// TestLeverageBucketsCoverTheVenues: the selector's values must each be
// offered by at least one venue, and "all" must be first so the unfiltered
// page is the max-leverage view.
func TestLeverageBucketsCoverTheVenues(t *testing.T) {
	if leverageBuckets[0].label != "all" || leverageBuckets[0].lev != 0 {
		t.Fatalf("first bucket must be the venue maximum, got %+v", leverageBuckets[0])
	}
	maxOffered := 1000.0 // Papertrade
	for _, b := range leverageBuckets[1:] {
		if b.lev <= 0 {
			t.Errorf("bucket %q has no leverage", b.label)
		}
		if b.lev > maxOffered {
			t.Errorf("bucket %q is above every venue's maximum", b.label)
		}
	}
}

// TestLeverageTermsLive hits all four venues for real and asserts the published
// numbers, not just that a call succeeded. Off by default so the suite stays
// hermetic; run it with OCB_LIVE=1 when an upstream shape may have moved, which
// is the one failure the fixtures cannot see.
func TestLeverageTermsLive(t *testing.T) {
	if os.Getenv("OCB_LIVE") == "" {
		t.Skip("set OCB_LIVE=1 to hit Arbitrum, Papertrade, Hyperliquid and dYdX")
	}
	s := NewLeverageTermsSource()
	groups := map[string][]venueTerms{
		"gains":       s.fetchGains(),
		"papertrade":  s.fetchPapertrade(),
		"hyperliquid": s.fetchHyperliquid(),
		"dydx":        s.fetchDydx(),
	}
	for venue, ts := range groups {
		if len(ts) == 0 {
			t.Errorf("%s returned no markets, its payload shape may have moved", venue)
			continue
		}
		for _, v := range ts {
			if !leverageTermsMarkets[v.market] {
				t.Errorf("%s returned an unexpected market %q", venue, v.market)
			}
			if v.maxLev < 10 {
				t.Errorf("%s/%s max leverage = %.0fx, implausibly low", venue, v.market, v.maxLev)
			}
			room, kept, ok := termsAt(v, v.maxLev)
			if !ok {
				t.Errorf("%s/%s produced no terms at its own maximum", venue, v.market)
				continue
			}
			if room <= 0 || room > 15 {
				t.Errorf("%s/%s room = %.4f%%, outside a plausible range", venue, v.market, room)
			}
			if kept < 0 || kept >= 100 {
				t.Errorf("%s/%s kept = %.2f%%, outside a plausible range", venue, v.market, kept)
			}
			t.Logf("%-12s %-4s %5.0fx room=%.4f%% kept=%.1f%%", venue, v.market, v.maxLev, room, kept)
		}
	}
	// The source must reach every venue over the network, not just parse.
	if _, err := s.Fetch(); err != nil {
		t.Fatalf("full fetch: %v", err)
	}
}
