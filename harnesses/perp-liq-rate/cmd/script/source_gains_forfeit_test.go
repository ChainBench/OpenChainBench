package main

// source_gains_forfeit_test.go: the forfeited-collateral decode pinned against
// two real Arbitrum logs, both pulled off the diamond on 2026-09-29 and both
// checked against the chain rather than against this harness.
//
// The first is the largest liquidation of the three days to 2026-09-29: tx
// 0x427c242f log 44 in block 509563262, a 200,227.73 dollar ETH position at
// 108.213x. Three facts about it were verified outside this package before the
// numbers below were written down:
//
//   - percentProfit is the price move times the leverage, and nothing else.
//     (2656.4004841944 - 2669.0395802376) / 2669.0395802376 x 108.213 is
//     -51.243695%, and the word reads -51.2436949324%. The same identity, with
//     the sign taken from t.long, held on 120 of 120 real liquidations.
//   - amountSentToTrader is zero, and the trader really did receive nothing:
//     the transaction's three USDC transfers out of the diamond (17,917.277954
//     + 141,319.232557 + 3,003.7154) all go to the vault at
//     0xd3443ee1e91af28e5fb858fbd0d72a63ba8046e0, and none to the trader at
//     0xabf68ea28e2522726f53b6413b87ef7067fdf21a.
//   - so the trader forfeited 48.76 points of margin on top of the 51.24 the
//     price had taken: 97,631 dollars of the 200,228 they posted, gone to
//     something other than their own loss.
//
// The second is the case that would have made this metric nonsense if it were
// let through: tx 0x58ac52c3 log 27, a long on pair 482 whose price had gone
// *up* 8.88% at 52.88x, closed with orderType LIQ_CLOSE and nothing returned.
// percentProfit reads +469.7186808606%, which the same identity confirms, so
// the word is being read correctly and the event is not a trader losing money
// to a move. Ten of 886 liquidations over three days looked like this. Left in,
// each would have contributed a forfeited share of 569 points.

import (
	"math"
	"math/big"
	"testing"
)

// goldenGainsBigEthLiquidation is tx 0x427c242f log 0x2c, word for word.
func goldenGainsBigEthLiquidation() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsLimitExecutedTopic,
			"0x000000000000000000000000abf68ea28e2522726f53b6413b87ef7067fdf21a",
			"0x0000000000000000000000000000000000000000000000000000000000000285",
			"0x0000000000000000000000000000000000000000000000000000000000000000",
		},
		Data: gainsLogWords(
			zeroWord, // w0  orderId.user
			zeroWord, // w1  orderId.index
			"000000000000000000000000abf68ea28e2522726f53b6413b87ef7067fdf21a", // w2  t.user
			"0000000000000000000000000000000000000000000000000000000000000285", // w3  t.index 645
			oneWord, // w4  t.pairIndex 1 (ETH/USD)
			"000000000000000000000000000000000000000000000000000000000001a6b5", // w5  t.leverage 108213
			oneWord, // w6  t.long
			oneWord, // w7  t.isOpen
			"0000000000000000000000000000000000000000000000000000000000000003", // w8  t.collateralIndex 3 (USDC)
			zeroWord, // w9  t.tradeType
			"0000000000000000000000000000000000000000000000000000002e9fb15033", // w10 t.collateralAmount 200247693363
			"00000000000000000000000000000000000000000000000000001846578f8b08", // w11 t.openPrice 2669.0395802376
			zeroWord, // w12 t.tp
			zeroWord, // w13 t.sl
			zeroWord, // w14 t.isCounterTrade
			"0000000000000000000000000000000000000000000001b71ba2d0eaec2530d8", // w15 t.positionSizeToken 8100.112032051147
			zeroWord, // w16 t.__placeholder
			"0000000000000000000000003b1ae4a6f8fbbe7659f0b0351e73436598cf2887", // w17 triggerCaller
			"0000000000000000000000000000000000000000000000000000000000000006", // w18 orderType LIQ_CLOSE
			"00000000000000000000000000000000000000000000000000001828ea1289d8", // w19 oraclePrice 2656.4004841944
			"00000000000000000000000000000000000000000000000000001828ea1289d8", // w20 marketPrice
			"00000000000000000000000000000000000000000000000000001828ea1289d8", // w21 liqPrice
			zeroWord, zeroWord, zeroWord, zeroWord, zeroWord, zeroWord, // w22-27 priceImpact
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffff88b060aeb4", // w28 percentProfit -51.2436949324%
			zeroWord, // w29 amountSentToTrader
			"0000000000000000000000000000000000000000000000000000000005f5ba0f", // w30 collateralPriceUsd 0.99990031
			oneWord, // w31 exactExecution
		),
		BlockNumber: "0x1e5c5cbe",
		TxHash:      "0x427c242fecac79bfe5be10737994f9c3860b7100db0ead386c83b2f1660497cd",
		LogIndex:    "0x2c",
	}
}

// goldenGainsPriceProfitLiquidation is tx 0x58ac52c3 log 0x1b: a LIQ_CLOSE on a
// long whose price had risen, so percentProfit is positive.
func goldenGainsPriceProfitLiquidation() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsLimitExecutedTopic,
			"0x000000000000000000000000201321dd6ed5796c586f8e3379afb409d4b19eb8",
			"0x0000000000000000000000000000000000000000000000000000000000002d0b",
			"0x0000000000000000000000000000000000000000000000000000000000000000",
		},
		Data: gainsLogWords(
			zeroWord, zeroWord, // w0-1 orderId
			"000000000000000000000000201321dd6ed5796c586f8e3379afb409d4b19eb8", // w2  t.user
			"0000000000000000000000000000000000000000000000000000000000002d0b", // w3  t.index
			"00000000000000000000000000000000000000000000000000000000000001e2", // w4  t.pairIndex 482
			"000000000000000000000000000000000000000000000000000000000000ce90", // w5  t.leverage 52880
			oneWord, // w6  t.long
			oneWord, // w7  t.isOpen
			"0000000000000000000000000000000000000000000000000000000000000003", // w8  t.collateralIndex 3
			zeroWord, // w9  t.tradeType
			"00000000000000000000000000000000000000000000000000000000003e7df0", // w10 t.collateralAmount 4095472
			"000000000000000000000000000000000000000000000000000000005f42a676", // w11 t.openPrice 0.159820351
			zeroWord, zeroWord, zeroWord, // w12-14 tp, sl, isCounterTrade
			"0000000000000000000000000000000000000000000000497574386dd89842ec", // w15 t.positionSizeToken 1355.0757690249698
			zeroWord, // w16 t.__placeholder
			"0000000000000000000000003b1ae4a6f8fbbe7659f0b0351e73436598cf2887", // w17 triggerCaller
			"0000000000000000000000000000000000000000000000000000000000000006", // w18 orderType LIQ_CLOSE
			"0000000000000000000000000000000000000000000000000000000067b8d9a4", // w19 oraclePrice 0.1740167588
			"0000000000000000000000000000000000000000000000000000000067b8d9a4", // w20 marketPrice
			"0000000000000000000000000000000000000000000000000000000067b8d9a4", // w21 liqPrice
			zeroWord, zeroWord, zeroWord, zeroWord, zeroWord, zeroWord, // w22-27 priceImpact
			"00000000000000000000000000000000000000000000000000000445a626b31e", // w28 percentProfit +469.7186808606%
			zeroWord, // w29 amountSentToTrader
			"0000000000000000000000000000000000000000000000000000000005f5b770", // w30 collateralPriceUsd 0.9998936
			oneWord, // w31 exactExecution
		),
		BlockNumber: "0x1e5686f9",
		TxHash:      "0x58ac52c341e4858141e60639f7c07218d1565cbce6b8980ba6a1db6d04ffcb56",
		LogIndex:    "0x1b",
	}
}

func TestGainsForfeit_GoldenBigEthLiquidation(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsBigEthLiquidation(), gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("decode (ok=%v): %v", ok, err)
	}
	if !ex.liquidation {
		t.Fatal("orderType 6 should decode as a liquidation")
	}
	if !ex.hasForfeit {
		t.Fatal("a forced close at a price loss must carry the forfeited detail")
	}
	// 200,247.693363 USDC at 0.99990031.
	if math.Abs(ex.collateralUSD-200_227.73) > 0.5 {
		t.Fatalf("collateral = %.2f, want 200,227.73", ex.collateralUSD)
	}
	if math.Abs(ex.leverage-108.213) > 1e-6 {
		t.Fatalf("leverage = %.6f, want 108.213", ex.leverage)
	}
	if math.Abs(ex.lossAtTriggerPct-51.2436949324) > 1e-6 {
		t.Fatalf("loss at trigger = %.10f%%, want 51.2436949324%%", ex.lossAtTriggerPct)
	}
	if ex.returnedUSD != 0 {
		t.Fatalf("returned = %.6f, want 0: every USDC transfer in this tx went to the vault", ex.returnedUSD)
	}

	// The whole point of the metric, on the one position that proves it: the
	// trader posted 200,228 dollars, lost 51.24% of it to the price, got none
	// of it back, and so forfeited the other 48.76 points.
	e := windowEntry{collateral: ex.collateralUSD, leverage: ex.leverage,
		hasForfeit: ex.hasForfeit, lossPct: ex.lossAtTriggerPct, returnedUSD: ex.returnedUSD}
	s, okF := e.forfeit()
	if !okF {
		t.Fatal("the entry should yield the forfeited arithmetic")
	}
	if math.Abs(s.loss-51.2437) > 1e-3 || s.returned != 0 || math.Abs(s.forfeited-48.7563) > 1e-3 {
		t.Fatalf("shares = loss %.4f returned %.4f forfeited %.4f, want 51.2437 / 0 / 48.7563",
			s.loss, s.returned, s.forfeited)
	}
	if got := leverageBandOf(ex.leverage); got != "100-200x" {
		t.Fatalf("108.213x landed in band %q, want 100-200x", got)
	}
	// And it is outside the range a venue-level median may be taken over: GMX
	// recorded no liquidation above 107x over the week measured, so a Gains
	// figure that included this position would be comparing product ranges.
	if inComparableRange(ex.leverage) {
		t.Fatal("108.213x should sit outside the comparable 10x to 100x range")
	}
}

// percentProfit is int256. Read unsigned, the same word is about 1.16e67 and a
// 51% loss becomes a number no clamp could rescue, which is why the decode has
// its own signed reader rather than reusing word().
func TestGainsForfeit_PercentProfitIsSigned(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsBigEthLiquidation(), gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("decode (ok=%v): %v", ok, err)
	}
	if ex.lossAtTriggerPct <= 0 || ex.lossAtTriggerPct > 100 {
		t.Fatalf("loss at trigger = %g, want a percentage between 0 and 100 (an unsigned read gives ~1.16e67)",
			ex.lossAtTriggerPct)
	}
}

// The identity the word was verified against: percentProfit equals the price
// move times the leverage, signed by t.long. It is reproduced here so a future
// change to any of the four offsets fails rather than drifting quietly.
func TestGainsForfeit_IdentityAgainstThePriceMove(t *testing.T) {
	for _, lg := range []ethLog{goldenGainsBigEthLiquidation(), goldenGainsPriceProfitLiquidation()} {
		data, err := hexBytes(lg.Data)
		if err != nil {
			t.Fatalf("hex: %v", err)
		}
		w := func(i int) float64 {
			f, _ := new(big.Float).SetInt(new(big.Int).SetBytes(data[i*32 : (i+1)*32])).Float64()
			return f
		}
		long := w(gainsWordLong) != 0
		open, liq := w(gainsWordOpenPrice)/1e10, w(gainsWordLiqPrice)/1e10
		lev := w(gainsWordLeverage) / 1e3
		move := (liq - open) / open
		if !long {
			move = -move
		}
		predicted := move * lev * 100

		ex, ok, derr := decodeGainsExecution(lg, gainsArbDecimals)
		if derr != nil || !ok {
			t.Fatalf("decode %s (ok=%v): %v", lg.TxHash, ok, derr)
		}
		// The decode stores the loss, so a positive predicted return is a
		// negative stored loss.
		if math.Abs(predicted+ex.lossAtTriggerPct) > 0.01 {
			t.Fatalf("%s: price move x leverage = %.6f%%, decoded loss %.6f%% (want the negation)",
				lg.TxHash, predicted, ex.lossAtTriggerPct)
		}
	}
}

// A LIQ_CLOSE whose price return was positive is a real log and not a trader
// losing money to a move. It keeps its notional and its collateral and it must
// not reach the forfeited arithmetic, where it would read 569 points.
func TestGainsForfeit_RefusesPriceProfitOnAForcedClose(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsPriceProfitLiquidation(), gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("decode (ok=%v): %v", ok, err)
	}
	if !ex.liquidation {
		t.Fatal("orderType 6 is still a liquidation")
	}
	if ex.hasForfeit {
		t.Fatalf("a forced close up %.2f%% on price entered the forfeited arithmetic", -ex.lossAtTriggerPct)
	}
	if ex.collateralUSD <= 0 || ex.notionalUSD <= 0 {
		t.Fatal("the row should still publish its collateral and its notional")
	}
	e := windowEntry{collateral: ex.collateralUSD, leverage: ex.leverage,
		hasForfeit: ex.hasForfeit, lossPct: ex.lossAtTriggerPct, returnedUSD: ex.returnedUSD}
	if _, okF := e.forfeit(); okF {
		t.Fatal("the window should not count the entry")
	}
}

// amountSentToTrader is in the collateral's decimals, like collateralAmount:
// a stop loss that returned 141,000 USDC reads as USD, not as 1.41e17.
func TestGainsForfeit_ReturnedUsesCollateralDecimals(t *testing.T) {
	lg := goldenGainsBigEthLiquidation()
	// Order type 5 (SL_CLOSE) with 141,319.232557 USDC returned.
	lg.Data = replaceWord(lg.Data, gainsWordOrderType,
		"0000000000000000000000000000000000000000000000000000000000000005")
	lg.Data = replaceWord(lg.Data, gainsWordAmountSentToTrader,
		"00000000000000000000000000000000000000000000000000000020e7485c2d")
	ex, ok, err := decodeGainsExecution(lg, gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("decode (ok=%v): %v", ok, err)
	}
	if math.Abs(ex.returnedUSD-141_305.11) > 1 {
		t.Fatalf("returned = %.2f, want about 141,305 (141,319.232557 USDC at 0.99990031)", ex.returnedUSD)
	}
	e := windowEntry{collateral: ex.collateralUSD, hasForfeit: ex.hasForfeit,
		lossPct: ex.lossAtTriggerPct, returnedUSD: ex.returnedUSD}
	s, okF := e.forfeit()
	if !okF {
		t.Fatal("a stop loss at a price loss carries the arithmetic too")
	}
	// 51.24 lost to the price, 70.57 back, so the three shares sum past 100
	// and nothing was forfeited beyond the loss.
	if math.Abs(s.returned-70.57) > 0.1 {
		t.Fatalf("returned share = %.2f%%, want about 70.57%%", s.returned)
	}
	if s.forfeited != 0 {
		t.Fatalf("forfeited = %.4f, want 0 when the loss and the payout sum past the margin", s.forfeited)
	}
}

// The word offsets differ by one between LimitExecuted and MarketExecuted,
// because the latter carries no triggerCaller and no orderType. A market close
// read at the LimitExecuted offsets picks up collateralPriceUsd as the payout.
func TestGainsForfeit_MarketExecutedOffsets(t *testing.T) {
	if gainsMarketWordPercentProfit != gainsWordPercentProfit-1 ||
		gainsMarketWordAmountSentToTrader != gainsWordAmountSentToTrader-1 {
		t.Fatal("MarketExecuted drops two words before these, so both sit one word earlier")
	}
	if gainsWordCollateralPriceUS-gainsWordAmountSentToTrader !=
		gainsWordMarketColPriceUSD-gainsMarketWordAmountSentToTrader {
		t.Fatal("the payout word must sit the same distance from the price word in both events")
	}
}

// The arithmetic describes a close, not an open. On an open both percentProfit
// and amountSentToTrader are zero, which would read as a position that lost
// nothing and got nothing back: a forfeit of 100 points. Only liquidations reach
// the window today, so this guards the day stop losses are published too.
func TestGainsForfeit_OpensCarryNoDetail(t *testing.T) {
	for _, ot := range []struct {
		word, name string
	}{
		{"0000000000000000000000000000000000000000000000000000000000000002", "LIMIT_OPEN"},
		{"0000000000000000000000000000000000000000000000000000000000000003", "STOP_OPEN"},
	} {
		lg := goldenGainsBigEthLiquidation()
		lg.Data = replaceWord(lg.Data, gainsWordOrderType, ot.word)
		lg.Data = replaceWord(lg.Data, gainsWordPercentProfit, zeroWord)
		ex, ok, err := decodeGainsExecution(lg, gainsArbDecimals)
		if err != nil || !ok {
			t.Fatalf("%s decode (ok=%v): %v", ot.name, ok, err)
		}
		if ex.hasForfeit {
			t.Fatalf("%s carried the forfeited detail; it would publish a 100 point forfeit", ot.name)
		}
	}
	// The three close types do carry it.
	for _, ot := range []struct {
		word, name string
	}{
		{"0000000000000000000000000000000000000000000000000000000000000004", "TP_CLOSE"},
		{"0000000000000000000000000000000000000000000000000000000000000005", "SL_CLOSE"},
		{"0000000000000000000000000000000000000000000000000000000000000006", "LIQ_CLOSE"},
	} {
		lg := goldenGainsBigEthLiquidation()
		lg.Data = replaceWord(lg.Data, gainsWordOrderType, ot.word)
		ex, ok, err := decodeGainsExecution(lg, gainsArbDecimals)
		if err != nil || !ok {
			t.Fatalf("%s decode (ok=%v): %v", ot.name, ok, err)
		}
		if !ex.hasForfeit {
			t.Fatalf("%s did not carry the forfeited detail", ot.name)
		}
	}
}
