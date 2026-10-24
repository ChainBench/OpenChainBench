package main

import (
	"encoding/json"
	"math"
	"math/big"
	"os"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
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
// The fee is the pair's position-size fee read from its fee group: 0.02% on the
// degen pairs, 0.035% on the standard ones.
func gainsVenue(t *testing.T, hexStr string, maxLev, feePerLeg float64) venueTerms {
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
		costPerLeg:  feePerLeg,
		forfeitsAll: true,
	}
}

// papertradeVenue mirrors fetchPapertrade: no fee at either leg, a buffer fixed
// in price, and a hard bust.
func papertradeVenue(t *testing.T, raw string) venueTerms {
	t.Helper()
	sym, lev, buf, ok := papertradeTerms(ptTuple(t, raw))
	if !ok {
		t.Fatalf("papertrade fixture rejected")
	}
	return venueTerms{venue: "papertrade", market: sym, maxLev: lev,
		maintenance: func(float64) float64 { return buf }, forfeitsAll: true}
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

// TestGainsRoomMatchesWhatLiquidationsShow is the test the measurement earned.
//
// The contract's threshold is 80% of collateral, which would put the room at
// 0.1600% of price at 500x. Eleven real liquidations on pairs 300 and 313 fired
// at a median 59.4% of collateral, which is 0.1189% of price. The gap is both
// fee legs: 0.02% x 500 x 2 is 20 points of collateral, and 80 - 20 is 60. The
// model therefore has to predict 60.0% and 0.1200%, within a point of the
// measurement, the remainder being borrowing which accrues with holding time
// and is not a term at open.
func TestGainsRoomMatchesWhatLiquidationsShow(t *testing.T) {
	g := gainsVenue(t, degenLiqParams, 500, 0.02)
	room, lost, kept, ok := termsAt(g, 500)
	if !ok {
		t.Fatal("rejected at 500x")
	}
	approx(t, "room at 500x", room, 0.12, 1e-9)
	approx(t, "collateral lost at 500x", lost, 60, 1e-9)
	approx(t, "collateral kept", kept, 0, 0)

	// Against the measurement, loosely: the model must land within a point of
	// the median, and must NOT reproduce the fee-free 0.16%.
	const measuredLostPct = 59.44
	if diff := lost - measuredLostPct; diff < 0 || diff > 1.5 {
		t.Errorf("model says %.2f%% of collateral, measured median %.2f%%, gap %.2f points",
			lost, measuredLostPct, diff)
	}
	if room > 0.15 {
		t.Errorf("room %.4f%% is back at the fee-free figure, the fee legs are missing", room)
	}
}

// TestGainsRoomScalesWithLeverage: the threshold is a share of collateral and
// flat on a degen pair, so the room falls close to proportionally with
// leverage. The fee legs bend it slightly, and the bend grows with leverage
// because the fee is a share of notional.
func TestGainsRoomScalesWithLeverage(t *testing.T) {
	g := gainsVenue(t, degenLiqParams, 500, 0.02)
	for _, c := range []struct{ lev, room, lost float64 }{
		{500, 0.12, 60.0},
		{200, 0.36, 72.0},
		{100, 0.76, 76.0},
		{50, 1.56, 78.0},
		{10, 7.96, 79.6},
	} {
		room, lost, kept, ok := termsAt(g, c.lev)
		if !ok {
			t.Fatalf("gains rejected at %.0fx", c.lev)
		}
		approx(t, "gains room", room, c.room, 1e-9)
		approx(t, "gains collateral lost", lost, c.lost, 1e-9)
		approx(t, "gains collateral kept", kept, 0, 0)
	}
}

// TestGainsDegenPairIsFixedLeverage is the test for a bug that shipped.
//
// pairMinLeverage and pairMaxLeverage both read 500x on pairs 300 and 313, so
// the degen cohort is a fixed-leverage product and 500x is its only legal
// value. The publisher originally refused only a leverage ABOVE the maximum, so
// the 10x, 25x, 50x, 100x and 200x tabs carried a Gains row for a position that
// cannot be opened.
func TestGainsDegenPairIsFixedLeverage(t *testing.T) {
	degen := gainsVenue(t, degenLiqParams, 500, 0.02)
	degen.minLev = 500

	for _, lev := range []float64{10, 25, 50, 100, 200, 499} {
		if _, _, _, ok := termsAt(degen, lev); ok {
			t.Errorf("degen pair accepted %.0fx, but its minimum is 500x", lev)
		}
	}
	room, lost, _, ok := termsAt(degen, 500)
	if !ok {
		t.Fatal("degen pair refused its only legal leverage")
	}
	approx(t, "degen room at 500x", room, 0.12, 1e-9)
	approx(t, "degen collateral lost", lost, 60, 1e-9)
}

// TestGainsPicksTheOpenableProduct: with the degen pair fixed at 500x, a
// trader wanting less leverage uses the standard pair, which runs 1.1x to 200x
// on a 90 percent threshold that interpolates to 75 between 25x and 60x. The
// venue must therefore publish the standard pair below 500x and the degen one
// at 500x, and neither where the leverage is offered by neither.
func TestGainsPicksTheOpenableProduct(t *testing.T) {
	std := gainsVenue(t, stdLiqParams, 200, 0.035)
	std.minLev = 1.1
	degen := gainsVenue(t, degenLiqParams, 500, 0.02)
	degen.minLev = 500

	pick := func(lev float64) (float64, string, bool) {
		best, name, found := -1.0, "", false
		for _, v := range []struct {
			t    venueTerms
			name string
		}{{std, "standard"}, {degen, "degen"}} {
			room, _, _, ok := termsAt(v.t, lev)
			if ok && room > best {
				best, name, found = room, v.name, true
			}
		}
		return best, name, found
	}

	for _, c := range []struct {
		lev  float64
		want string
		room float64
	}{
		{10, "standard", 8.93},   // (90 - 2*0.035*10) / 10
		{25, "standard", 3.53},   // threshold still 90 at the floor
		{100, "standard", 0.68},  // threshold 75 above 60x
		{200, "standard", 0.305}, // the standard pair's own ceiling
		{500, "degen", 0.12},     // only the degen pair reaches here
	} {
		room, name, ok := pick(c.lev)
		if !ok {
			t.Fatalf("no gains product at %.0fx", c.lev)
		}
		if name != c.want {
			t.Errorf("at %.0fx picked the %s pair, want %s", c.lev, name, c.want)
		}
		approx(t, "gains room", room, c.room, 1e-9)
	}

	// 1000x is offered by neither, so the venue is absent from that tab.
	if _, _, ok := pick(1000); ok {
		t.Error("gains published a row at 1000x, which neither pair offers")
	}
}

// TestGainsReturnsNothing states the measurement plainly: amountSentToTrader
// was 0 on all 27 liquidations found, every pair, 7.5x to 500x. The 20 points
// the threshold leaves never reach the trader, so the column is a real zero at
// every leverage and not a figure derived from the threshold.
func TestGainsReturnsNothing(t *testing.T) {
	g := gainsVenue(t, degenLiqParams, 500, 0.02)
	for _, lev := range []float64{10, 50, 100, 500} {
		_, _, kept, ok := termsAt(g, lev)
		if !ok {
			t.Fatalf("rejected at %.0fx", lev)
		}
		if kept != 0 {
			t.Errorf("gains returned %.2f%% at %.0fx, measurement says nothing comes back", kept, lev)
		}
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

	pt := papertradeVenue(t, ptBTCInstrument)

	room, lost, kept, ok := termsAt(pt, 1000)
	if !ok {
		t.Fatal("rejected at 1000x")
	}
	// The docs' own worked figure, to their stated precision.
	approx(t, "room at 1000x", room, 0.052, 5e-4)
	// And in the unit venues quote among themselves: Sacha at Gains read this
	// as "almost 50% of collat", which is this number.
	approx(t, "collateral lost at 1000x", lost, 52.4, 0.1)
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

	pt := papertradeVenue(t, ptBTCInstrument)
	// Room shrinks with leverage like everywhere else; it is the buffer that
	// is constant, not the room. The first version of this source had that
	// backwards and claimed the room was identical at 1x and 1000x.
	r10, _, _, _ := termsAt(pt, 10)
	r1000, _, _, _ := termsAt(pt, 1000)
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
// rule. Neither publishes a fee in the payload we read, so their rows carry no
// fee legs and the bench says so.
//
// The trap is that the share returned is a ratio of the two fractions and not
// their difference, because the collateral posted is the initial one.
func TestMarginFractionVenues(t *testing.T) {
	// dYdX BTC-USD, read live 2026-10-12: IMF 0.02, MMF 0.012.
	dydx := venueTerms{venue: "dydx", maxLev: 1 / 0.02,
		maintenance: func(float64) float64 { return 0.012 }}
	approx(t, "dydx max leverage", dydx.maxLev, 50, 1e-9)
	for _, c := range []struct{ lev, room, lost, kept float64 }{
		{50, 0.8, 40, 60},
		{25, 2.8, 70, 30},
		{10, 8.8, 88, 12},
	} {
		room, lost, kept, ok := termsAt(dydx, c.lev)
		if !ok {
			t.Fatalf("dydx rejected at %.0fx", c.lev)
		}
		approx(t, "dydx room", room, c.room, 1e-9)
		approx(t, "dydx lost", lost, c.lost, 1e-9)
		approx(t, "dydx kept", kept, c.kept, 1e-9)
	}

	// Hyperliquid BTC: maxLeverage 40, maintenance at half the initial
	// requirement, so the share returned is 50 percent at the maximum
	// whatever the asset.
	hl := venueTerms{venue: "hyperliquid", maxLev: 40,
		maintenance: func(float64) float64 { return 1.0 / 80 }}
	for _, c := range []struct{ lev, room, lost, kept float64 }{
		{40, 1.25, 50, 50},
		{10, 8.75, 87.5, 12.5},
	} {
		room, lost, kept, ok := termsAt(hl, c.lev)
		if !ok {
			t.Fatalf("hyperliquid rejected at %.0fx", c.lev)
		}
		approx(t, "hl room", room, c.room, 1e-9)
		approx(t, "hl lost", lost, c.lost, 1e-9)
		approx(t, "hl kept", kept, c.kept, 1e-9)
	}
}

// TestTermsAtRefusesImpossible: a leverage the venue does not offer, or costs
// that swallow the whole margin, is refused rather than published. A venue that
// published a leverage but no room would read as the safest row on the board.
func TestTermsAtRefusesImpossible(t *testing.T) {
	v := venueTerms{maxLev: 40, maintenance: func(float64) float64 { return 1.0 / 80 }}
	for _, lev := range []float64{0, -10, 41, 1000} {
		if _, _, _, ok := termsAt(v, lev); ok {
			t.Errorf("accepted leverage %.0f on a 40x venue", lev)
		}
	}
	tight := venueTerms{maxLev: 100, maintenance: func(float64) float64 { return 0.02 }}
	if _, _, _, ok := termsAt(tight, 100); ok {
		t.Error("accepted a maintenance requirement above the margin posted")
	}
	if _, _, _, ok := termsAt(venueTerms{maxLev: 10, maintenance: func(float64) float64 { return 0 }}, 10); ok {
		t.Error("accepted a zero maintenance requirement")
	}
	// Fees alone can exhaust the margin at high leverage: a 0.2% fee a leg at
	// 250x is the whole collateral twice over.
	feeHeavy := venueTerms{maxLev: 500, costPerLeg: 0.2,
		maintenance: func(lev float64) float64 { return 0.2 / 100 / lev }}
	if _, _, _, ok := termsAt(feeHeavy, 250); ok {
		t.Error("accepted a position whose fees exceed its margin")
	}
}

// TestRankingInvertsWithLeverage is the finding the leverage selector exists
// for, and the reason the bench publishes no single ranking.
//
// At each venue's OWN maximum the room shrinks as leverage grows, which reads
// as a ranking but compares four different leverages. At a leverage they all
// offer the order is different, and Papertrade leads because its maintenance
// requirement is five basis points of price where the others hold back more
// than a percent of notional.
//
// Measured, not modelled, on the Gains side: its room at 500x is the one 11
// real liquidations show, and Papertrade's is a ceiling 384 adverse closes
// never crossed.
func TestRankingInvertsWithLeverage(t *testing.T) {
	pt := papertradeVenue(t, ptBTCInstrument)
	gains := gainsVenue(t, degenLiqParams, 500, 0.02)
	dydx := venueTerms{venue: "dydx", maxLev: 50, maintenance: func(float64) float64 { return 0.012 }}
	hl := venueTerms{venue: "hyperliquid", maxLev: 40, maintenance: func(float64) float64 { return 1.0 / 80 }}

	// At each venue's own maximum: more leverage, less room, monotonically.
	ptMax, _, ptKeptMax, _ := termsAt(pt, pt.maxLev)
	gMax, _, gKeptMax, _ := termsAt(gains, gains.maxLev)
	dMax, _, dKeptMax, _ := termsAt(dydx, dydx.maxLev)
	hMax, _, hKeptMax, _ := termsAt(hl, hl.maxLev)
	if !(ptMax < gMax && gMax < dMax && dMax < hMax) {
		t.Errorf("at max leverage the room should shrink as leverage grows: pt=%.4f gains=%.4f dydx=%.4f hl=%.4f",
			ptMax, gMax, dMax, hMax)
	}

	// At 500x, the only setting Gains and Papertrade both offer, Papertrade
	// leads once Gains' fee legs are counted. Before the fees were counted the
	// bench published 0.1600 for Gains and had this the other way round.
	g500, _, _, _ := termsAt(gains, 500)
	p500, _, _, _ := termsAt(pt, 500)
	approx(t, "gains at 500x", g500, 0.12, 1e-9)
	approx(t, "papertrade at 500x", p500, 0.1523958419912426, 1e-9)
	if !(p500 > g500) {
		t.Errorf("at 500x papertrade should leave more room: pt=%.4f gains=%.4f", p500, g500)
	}

	// At 10x, which all four offer, Gains is last: it liquidates at a share of
	// collateral whatever the leverage, which is harsh when leverage is low.
	pt10, _, _, _ := termsAt(pt, 10)
	g10, _, _, _ := termsAt(gains, 10)
	d10, _, _, _ := termsAt(dydx, 10)
	h10, _, _, _ := termsAt(hl, 10)
	if !(pt10 > d10 && d10 > h10 && h10 > g10) {
		t.Errorf("at 10x expected pt > dydx > hl > gains, got pt=%.4f dydx=%.4f hl=%.4f gains=%.4f",
			pt10, d10, h10, g10)
	}

	// The collateral column does not invert, and it is the one where the two
	// high-leverage venues are alike: neither returns anything, measured on
	// both sides. The two margin-fraction venues do return something.
	approx(t, "papertrade kept at its max", ptKeptMax, 0, 0)
	approx(t, "gains kept at its max", gKeptMax, 0, 0)
	for name, kept := range map[string]float64{"dydx": dKeptMax, "hyperliquid": hKeptMax} {
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
		"papertrade":  s.fetchPapertrade(),
		"hyperliquid": s.fetchHyperliquid(),
		"dydx":        s.fetchDydx(),
	}
	for _, g := range gtradeVenues {
		groups[g.venue] = s.fetchGtrade(g.venue, g.diamond)
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
			room, lost, kept, ok := termsAt(v, v.maxLev)
			if !ok {
				t.Errorf("%s/%s produced no terms at its own maximum", venue, v.market)
				continue
			}
			if room <= 0 || room > 15 {
				t.Errorf("%s/%s room = %.4f%%, outside a plausible range", venue, v.market, room)
			}
			if lost <= 0 || lost > 100 {
				t.Errorf("%s/%s collateral lost = %.2f%%, outside a plausible range", venue, v.market, lost)
			}
			if kept < 0 || kept >= 100 {
				t.Errorf("%s/%s kept = %.2f%%, outside a plausible range", venue, v.market, kept)
			}
			// The two units must agree by construction: lost is room times
			// leverage. A mismatch means one of them was computed elsewhere.
			if diff := lost - room*v.maxLev; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("%s/%s units disagree: lost=%.4f, room*lev=%.4f", venue, v.market, lost, room*v.maxLev)
			}
			// Gains is measured to return nothing; so is Papertrade by its
			// hard bust rule.
			if (venue == "gains" || venue == "papertrade") && kept != 0 {
				t.Errorf("%s/%s returned %.2f%%, measurement says nothing comes back", venue, v.market, kept)
			}
			t.Logf("%-12s %-4s %5.0fx room=%.4f%% lost=%.1f%% kept=%.1f%%",
				venue, v.market, v.maxLev, room, lost, kept)
		}
	}
	// The source must reach every venue over the network, not just parse.
	if _, err := s.Fetch(); err != nil {
		t.Fatalf("full fetch: %v", err)
	}
}

// TestAllTabReadsTheCeilingProduct pins the "Each venue at its max" tab to the
// product that reaches the ceiling. The standard pair at its own 200x leaves
// 0.305% against the degen pair's 0.12% at 500x; letting the larger room win
// published 500x in the max leverage column beside the 200x room.
func TestAllTabReadsTheCeilingProduct(t *testing.T) {
	std := gainsVenue(t, stdLiqParams, 200, 0.035)
	std.minLev = 1.1
	degen := gainsVenue(t, degenLiqParams, 500, 0.02)
	degen.minLev = 500

	publishLeverageTerms([]venueTerms{std, degen})
	if got := testutil.ToFloat64(perpLeverageMax.WithLabelValues("gains", "BTC", "all")); got != 500 {
		t.Fatalf("max leverage on the all tab = %v, want 500", got)
	}
	approx(t, "all tab room", testutil.ToFloat64(perpLiqPriceMovePct.WithLabelValues("gains", "BTC", "all")), 0.12, 1e-9)
}
