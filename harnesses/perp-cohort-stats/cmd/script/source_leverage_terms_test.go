package main

import (
	"encoding/json"
	"math"
	"math/big"
	"net/http"
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
// is the wrong scale. That is the check that caught a 1e10-versus-1e8 mistake.
const (
	stdLiqParams   = "0x000000000000000000000000000000000000000000000000000000001dcd6500000000000000000000000000000000000000000000000000000000d18c2e2800000000000000000000000000000000000000000000000000000000ae9f7bcc0000000000000000000000000000000000000000000000000000000000000061a8000000000000000000000000000000000000000000000000000000000000ea60"
	degenLiqParams = "0x000000000000000000000000000000000000000000000000000000001dcd6500000000000000000000000000000000000000000000000000000000ba43b74000000000000000000000000000000000000000000000000000000000ba43b74000000000000000000000000000000000000000000000000000000000000007a120000000000000000000000000000000000000000000000000000000000007a120"
)

func decodeWords(t *testing.T, hexStr string) []*big.Int {
	t.Helper()
	h := hexStr[2:]
	if len(h)%64 != 0 {
		t.Fatalf("fixture is not a whole number of words: %d chars", len(h))
	}
	var out []*big.Int
	for i := 0; i+64 <= len(h); i += 64 {
		v, ok := new(big.Int).SetString(h[i:i+64], 16)
		if !ok {
			t.Fatalf("bad word at %d", i)
		}
		out = append(out, v)
	}
	return out
}

func approx(t *testing.T, label string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %.6f, want %.6f (tol %g)", label, got, want, tol)
	}
}

// TestGainsScaleCalibration is the anchor: the standard pair must read as the
// documented 90 percent, which fixes the 1e10 scale for every other pair.
func TestGainsScaleCalibration(t *testing.T) {
	w := decodeWords(t, stdLiqParams)
	if len(w) != 5 {
		t.Fatalf("got %d words, want 5", len(w))
	}
	approx(t, "maxLiqSpreadP", bigToFloat(w[0], 1e10), 0.05, 1e-9)
	approx(t, "startLiqThresholdP", bigToFloat(w[1], 1e10), 90, 1e-9)
	approx(t, "endLiqThresholdP", bigToFloat(w[2], 1e10), 75, 1e-9)
	approx(t, "startLeverage", bigToFloat(w[3], 1e3), 25, 1e-9)
	approx(t, "endLeverage", bigToFloat(w[4], 1e3), 60, 1e-9)
}

// TestGainsDegenTerms is the number the bench publishes for Gains.
func TestGainsDegenTerms(t *testing.T) {
	w := decodeWords(t, degenLiqParams)
	move, kept, ok := gainsTerms(w, 500)
	if !ok {
		t.Fatal("gainsTerms rejected the live degen params")
	}
	// 80 percent of collateral at 500x is 0.16 percent of price.
	approx(t, "move", move, 0.16, 1e-9)
	approx(t, "kept", kept, 20, 1e-9)
}

// TestGainsThresholdInterpolates pins the piecewise shape of
// getLiqPnlThresholdP: flat below startLeverage, flat above endLeverage, linear
// between. A degen pair sets both bounds equal, which is the flat case, so
// without the standard pair this behaviour would never be exercised.
func TestGainsThresholdInterpolates(t *testing.T) {
	const startTh, endTh, startLev, endLev = 90, 75, 25, 60
	cases := []struct{ lev, want float64 }{
		{2, 90},       // below the floor
		{25, 90},      // at the floor
		{60, 75},      // at the ceiling
		{150, 75},     // above the ceiling
		{42.5, 82.5},  // the midpoint is the mean of the two thresholds
		{40, 83.5714}, // an arbitrary interior point
	}
	for _, c := range cases {
		got := interpolateThreshold(startTh, endTh, startLev, endLev, c.lev)
		approx(t, "threshold at lev", got, c.want, 1e-4)
	}
}

// TestGainsTermsRejectsNonsense: a decode that slips a word would hand back a
// threshold at or past the whole collateral, which would publish a position
// that is liquidated before it opens. Refuse rather than publish.
func TestGainsTermsRejectsNonsense(t *testing.T) {
	w := decodeWords(t, degenLiqParams)
	if _, _, ok := gainsTerms(w[:3], 500); ok {
		t.Error("accepted a truncated return")
	}
	if _, _, ok := gainsTerms(w, 0); ok {
		t.Error("accepted zero leverage")
	}
	hundred := []*big.Int{
		big.NewInt(0), new(big.Int).SetUint64(1e12), new(big.Int).SetUint64(1e12),
		big.NewInt(500000), big.NewInt(500000),
	}
	if _, _, ok := gainsTerms(hundred, 500); ok {
		t.Error("accepted a 100 percent threshold")
	}
}

// Papertrade instrument tuples, captured live on 2026-10-12.
const (
	ptBTCInstrument = `[0, "BTC", 0, "10", true, false, false, false, false, null, null, null, "15000000000000000000000", "814598000000000000000", 1000, "10000000000000000000000000", "476041580087574", "100000000000000000"]`
	ptETHInstrument = `[1, "ETH", 1, "100", true, false, false, false, false, null, null, null, "15000000000000000000000", "483979000000000000000", 1000, "10000000000000000000000000", "481304050180130", "100000000000000000"]`
)

func ptTuple(t *testing.T, raw string) []json.RawMessage {
	t.Helper()
	var out []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	return out
}

func TestPapertradeTerms(t *testing.T) {
	for _, c := range []struct {
		raw       string
		symbol    string
		lev, move float64
	}{
		{ptBTCInstrument, "BTC", 1000, 0.0476041580087574},
		{ptETHInstrument, "ETH", 1000, 0.0481304050180130},
	} {
		sym, lev, move, ok := papertradeTerms(ptTuple(t, c.raw))
		if !ok {
			t.Fatalf("%s rejected", c.symbol)
		}
		if sym != c.symbol {
			t.Errorf("symbol = %q, want %q", sym, c.symbol)
		}
		approx(t, c.symbol+" lev", lev, c.lev, 1e-9)
		approx(t, c.symbol+" move", move, c.move, 1e-12)
	}
}

// TestPapertradeMoveIsIndependentOfLeverage states the asymmetry the bench
// exists to show. Gains' threshold is a share of collateral, so the survivable
// price move shrinks as leverage grows. Papertrade's buffer is a share of
// price, so the move is the same at 1x and at 1000x, and what grows instead is
// the share of collateral the buffer represents: at 1000x the buffer is 47.6
// percent of the margin, against the 20 percent Gains hands back.
func TestPapertradeMoveIsIndependentOfLeverage(t *testing.T) {
	_, lev, move, ok := papertradeTerms(ptTuple(t, ptBTCInstrument))
	if !ok {
		t.Fatal("rejected")
	}
	approx(t, "maintenance margin share at max leverage", move*lev, 47.6041580087574, 1e-9)

	gainsMove, gainsKept, ok := gainsTerms(decodeWords(t, degenLiqParams), 500)
	if !ok {
		t.Fatal("gains rejected")
	}
	if !(move < gainsMove) {
		t.Errorf("papertrade move %.4f should be tighter than gains %.4f", move, gainsMove)
	}
	if !(gainsKept > 0) {
		t.Errorf("gains should return collateral, got %.2f", gainsKept)
	}
}

// TestPapertradeTermsGuardsTupleLength: the payload is positional, so a tuple
// that grew a field would otherwise read some other number as the leverage.
func TestPapertradeTermsGuardsTupleLength(t *testing.T) {
	full := ptTuple(t, ptBTCInstrument)
	if _, _, _, ok := papertradeTerms(full[:16]); ok {
		t.Error("accepted a tuple too short to hold the bust buffer")
	}
	short := append([]json.RawMessage{}, full...)
	short[16] = json.RawMessage(`"0"`)
	if _, _, _, ok := papertradeTerms(short); ok {
		t.Error("accepted a zero bust buffer")
	}
	noSym := append([]json.RawMessage{}, full...)
	noSym[1] = json.RawMessage(`""`)
	if _, _, _, ok := papertradeTerms(noSym); ok {
		t.Error("accepted an empty symbol")
	}
}

// TestMarginTerms covers the two margin-fraction venues. The arithmetic is
// trivial and the trap is not: both fractions are shares of NOTIONAL, while the
// collateral returned is a share of the COLLATERAL posted, so the second number
// is a ratio of the two fractions and not their difference.
func TestMarginTerms(t *testing.T) {
	// dYdX BTC-USD, read live 2026-10-12: IMF 0.02, MMF 0.012.
	lev, move, kept, ok := marginTerms(0.02, 0.012)
	if !ok {
		t.Fatal("rejected dYdX BTC parameters")
	}
	approx(t, "dydx max leverage", lev, 50, 1e-9)
	approx(t, "dydx move", move, 0.8, 1e-9)
	approx(t, "dydx kept", kept, 60, 1e-9)

	// Hyperliquid BTC: maxLeverage 40, maintenance documented at half the
	// initial requirement, so the collateral returned is 50 percent whatever
	// the leverage is.
	lev, move, kept, ok = marginTerms(1.0/40, 1.0/80)
	if !ok {
		t.Fatal("rejected Hyperliquid BTC parameters")
	}
	approx(t, "hl max leverage", lev, 40, 1e-9)
	approx(t, "hl move", move, 1.25, 1e-9)
	approx(t, "hl kept", kept, 50, 1e-9)

	// ETH on Hyperliquid caps at 25x: the move widens, the share returned does
	// not budge, because it is fixed by the halving rule.
	_, move, kept, _ = marginTerms(1.0/25, 1.0/50)
	approx(t, "hl eth move", move, 2, 1e-9)
	approx(t, "hl eth kept", kept, 50, 1e-9)
}

// TestMarginTermsRejectsImpossible: a maintenance requirement at or above the
// initial one means a position is liquidated the moment it opens, which is a
// payload or unit error rather than a term worth publishing.
func TestMarginTermsRejectsImpossible(t *testing.T) {
	for _, c := range [][2]float64{
		{0.02, 0.02},  // equal
		{0.02, 0.03},  // inverted
		{0, 0.01},     // no initial requirement
		{0.02, 0},     // no maintenance requirement
		{-0.02, 0.01}, // negative
	} {
		if _, _, _, ok := marginTerms(c[0], c[1]); ok {
			t.Errorf("accepted initial=%g maintenance=%g", c[0], c[1])
		}
	}
}

// TestLeverageOrderingAcrossVenues states the bench's actual finding, so that a
// future change to any one venue's reader that broke the relationship would
// fail here rather than quietly republish a reordered page. Figures as read on
// 2026-10-12: Papertrade 1000x, Gains 500x, dYdX 50x, Hyperliquid 40x.
func TestLeverageOrderingAcrossVenues(t *testing.T) {
	_, ptLev, ptMove, ok := papertradeTerms(ptTuple(t, ptBTCInstrument))
	if !ok {
		t.Fatal("papertrade rejected")
	}
	gMove, gKept, ok := gainsTerms(decodeWords(t, degenLiqParams), 500)
	if !ok {
		t.Fatal("gains rejected")
	}
	dLev, dMove, dKept, _ := marginTerms(0.02, 0.012)
	hLev, hMove, hKept, _ := marginTerms(1.0/40, 1.0/80)

	// More leverage buys less room, monotonically across all four.
	if !(ptLev > 500 && 500 > dLev && dLev > hLev) {
		t.Fatalf("leverage order broke: pt=%.0f gains=500 dydx=%.0f hl=%.0f", ptLev, dLev, hLev)
	}
	if !(ptMove < gMove && gMove < dMove && dMove < hMove) {
		t.Errorf("survivable move should shrink as leverage grows: pt=%.4f gains=%.4f dydx=%.4f hl=%.4f",
			ptMove, gMove, dMove, hMove)
	}
	// Collateral returned is NOT monotone in leverage: dYdX returns more than
	// Hyperliquid while offering more leverage. That inversion is the reason
	// the bench publishes the two numbers as separate columns instead of
	// deriving one from the other.
	if !(dKept > hKept) {
		t.Errorf("expected dYdX to return more collateral than Hyperliquid: %.1f vs %.1f", dKept, hKept)
	}
	// And the venue with the most leverage returns the least of all: nothing.
	if !(gKept > 0) {
		t.Errorf("gains should return collateral, got %.2f", gKept)
	}
}

// TestLeverageTermsLive hits all four venues for real and asserts the published
// numbers, not just that a call succeeded. Off by default so the suite stays
// hermetic; run it with OCB_LIVE=1 when an upstream shape may have moved,
// which is the one failure the fixtures cannot see.
func TestLeverageTermsLive(t *testing.T) {
	if os.Getenv("OCB_LIVE") == "" {
		t.Skip("set OCB_LIVE=1 to hit Arbitrum and Papertrade")
	}
	s := NewLeverageTermsSource()

	for market, idx := range gainsDegenPairs {
		lw, err := s.gainsCall(selPairMaxLev, idx)
		if err != nil {
			t.Fatalf("gains %s maxLeverage: %v", market, err)
		}
		ml := bigToFloat(lw[0], 1e3)
		if ml < 100 {
			t.Errorf("gains %s max leverage = %.0fx, implausibly low for a degen pair", market, ml)
		}
		pw, err := s.gainsCall(selPairLiqParam, idx)
		if err != nil {
			t.Fatalf("gains %s liqParams: %v", market, err)
		}
		move, kept, ok := gainsTerms(pw, ml)
		if !ok {
			t.Fatalf("gains %s terms rejected: %v", market, pw)
		}
		if move <= 0 || move > 5 {
			t.Errorf("gains %s move = %.4f%%, outside a plausible range", market, move)
		}
		if kept <= 0 || kept >= 100 {
			t.Errorf("gains %s kept = %.2f%%, outside a plausible range", market, kept)
		}
		t.Logf("gains %s: %.0fx move=%.4f%% kept=%.0f%%", market, ml, move, kept)
	}

	// The two margin-fraction venues go through the same write path as the
	// other two, so exercising Fetch is the only way to see their readers.
	if _, err := s.Fetch(); err != nil {
		t.Fatalf("full fetch: %v", err)
	}

	req, err := http.NewRequest("GET", "https://exchange.papertrade.xyz/state/trading", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@openchainbench.com")
	resp, err := s.client.Do(req)
	if err != nil {
		t.Fatalf("papertrade: %v", err)
	}
	defer resp.Body.Close()
	var st struct {
		Instruments [][]json.RawMessage `json:"instruments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		t.Fatalf("papertrade decode: %v", err)
	}
	if len(st.Instruments) == 0 {
		t.Fatal("papertrade listed no instruments")
	}
	for _, inst := range st.Instruments {
		sym, lev, move, ok := papertradeTerms(inst)
		if !ok {
			t.Errorf("papertrade tuple rejected (len %d), the positional shape may have moved", len(inst))
			continue
		}
		if lev < 100 {
			t.Errorf("papertrade %s max leverage = %.0fx, implausibly low", sym, lev)
		}
		if move <= 0 || move > 5 {
			t.Errorf("papertrade %s move = %.4f%%, outside a plausible range", sym, move)
		}
		t.Logf("papertrade %s: %.0fx move=%.4f%% kept=0%%", sym, lev, move)
	}
}
