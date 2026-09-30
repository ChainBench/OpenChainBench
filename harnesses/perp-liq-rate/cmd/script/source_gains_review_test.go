package main

// source_gains_review_test.go: the position-size cross-check, pinned on a
// real WETH-collateral leg.
//
// The check compares the event's two encodings of position size, and both are
// in *collateral* units: collateralAmount x leverage, and positionSizeToken x
// openPrice, because the contract stores positionSizeToken as the size
// divided by the open price. Comparing the USD figure against the
// collateral-unit one, as this harness did until 2026-09-28, is off by a
// factor of the collateral's price whenever the collateral is not a
// stablecoin. That refused 56 real legs in the first 24h after deploy,
// including ETH ones this bench publishes, and their notional went missing
// from both the numerator and the venue's traded total.

import (
	"strings"
	"testing"
)

// A real WETH-collateral ETH open: tx 0xcd3191d4...00d7 log 0x23 in Arbitrum
// block 509382633. 0.2057 WETH at 59x is 12.1363 WETH of position, which the
// event also writes as positionSizeToken 0.004480066307594905 at openPrice
// 2708.955441: 0.004480066307594905 x 2708.955441 = 12.1363 WETH, to the
// unit. At collateralPriceUsd 2709.13 that is $32,878.81 of notional.
func goldenGainsWethOpen() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsMarketExecutedTopic,
			"0x000000000000000000000000ee3bcf4604b53af1b3a9ef187a699582c08f8a01",
			"0x00000000000000000000000000000000000000000000000000000000000013ac",
		},
		Data: gainsWords(
			"000000000000000000000000ee3bcf4604b53af1b3a9ef187a699582c08f8a01", // w0  orderId.user
			"00000000000000000000000000000000000000000000000000000000000013e0", // w1  orderId.index
			"000000000000000000000000ee3bcf4604b53af1b3a9ef187a699582c08f8a01", // w2  t.user
			"00000000000000000000000000000000000000000000000000000000000013ac", // w3  t.index
			"0000000000000000000000000000000000000000000000000000000000000001", // w4  t.pairIndex 1 (ETH)
			"000000000000000000000000000000000000000000000000000000000000e678", // w5  t.leverage 59000
			"0000000000000000000000000000000000000000000000000000000000000001", // w6  t.long
			"0000000000000000000000000000000000000000000000000000000000000001", // w7  t.isOpen
			"0000000000000000000000000000000000000000000000000000000000000002", // w8  t.collateralIndex 2 (WETH)
			"0000000000000000000000000000000000000000000000000000000000000000", // w9  t.tradeType
			"00000000000000000000000000000000000000000000000002dacb0f664c4000", // w10 t.collateralAmount 0.2057 WETH
			"000000000000000000000000000000000000000000000000000018a347448a10", // w11 t.openPrice 2708.955441
			"0000000000000000000000000000000000000000000000000000000000000000", // w12 t.tp
			"0000000000000000000000000000000000000000000000000000000000000000", // w13 t.sl
			"0000000000000000000000000000000000000000000000000000000000000000", // w14 t.isCounterTrade
			"000000000000000000000000000000000000000000000000000fea98b8d59a99", // w15 t.positionSizeToken 0.00448006630759
			"0000000000000000000000000000000000000000000000000000000000000000", // w16 t.__placeholder
			"0000000000000000000000000000000000000000000000000000000000000001", // w17 open = true
			"000000000000000000000000000000000000000000000000000018a2f689e200", // w18 oraclePrice
			"000000000000000000000000000000000000000000000000000018a347448a10", // w19 marketPrice
			"0000000000000000000000000000000000000000000000000000185735363c85", // w20 liqPrice
			"000000000000000000000000000000000000000000000000000fea98b8d59a99", // w21 priceImpact.positionSizeToken
			"0000000000000000000000000000000000000000000000000000000002faf080", // w22 priceImpact.fixedSpreadP
			"0000000000000000000000000000000000000000000000000000000000000000", // w23
			"0000000000000000000000000000000000000000000000000000000000000000", // w24
			"0000000000000000000000000000000000000000000000000000000002faf080", // w25 priceImpact.totalPriceImpactP
			"000000000000000000000000000000000000000000000000000018a347448a10", // w26 priceImpact.priceAfterImpact
			"0000000000000000000000000000000000000000000000000000000000000000", // w27 percentProfit
			"0000000000000000000000000000000000000000000000000000000000000000", // w28 amountSentToTrader
			"0000000000000000000000000000000000000000000000000000003f13ac5240", // w29 collateralPriceUsd 2709.13
		),
		BlockNumber: "0x1e5c8fe9",
		TxHash:      "0xcd3191d41d1563cbe7dcd285e2697d00c691028f01e014aa51622abd208d00d7",
		LogIndex:    "0x23",
	}
}

func TestGainsDecode_GoldenWethCollateralLeg(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsWethOpen(), gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("a real WETH-collateral ETH leg was refused: ok=%v err=%v", ok, err)
	}
	if ex.pair != 1 || ex.kind != gainsKindMarket || ex.liquidation {
		t.Fatalf("pair=%d kind=%s liquidation=%v", ex.pair, ex.kind, ex.liquidation)
	}
	// 0.2057 WETH x 59 x $2,709.13 = $32,878.81.
	if ex.notionalUSD < 32878 || ex.notionalUSD > 32880 {
		t.Fatalf("notional = %.2f, want about $32,878.81", ex.notionalUSD)
	}
	// The collateral behind it is the 0.2057 WETH, in USD.
	if ex.collateralUSD < 557 || ex.collateralUSD > 558 {
		t.Fatalf("collateral = %.2f, want about $557.27", ex.collateralUSD)
	}
	if ex.leverage < 58.9 || ex.leverage > 59.1 {
		t.Fatalf("leverage = %.2f, want 59", ex.leverage)
	}
}

// The cross-check still catches a scale error, on volatile collateral as on a
// stablecoin, because both sides of it are in collateral units.
func TestGainsDecode_WethLegStillCatchesAScaleError(t *testing.T) {
	lg := goldenGainsWethOpen()
	lg.Data = replaceWord(lg.Data, gainsWordLeverage,
		"00000000000000000000000000000000000000000000000000000000000900b0") // 59000 x 10
	if _, _, err := decodeGainsExecution(lg, gainsArbDecimals); err == nil {
		t.Fatal("a 10x leverage error on WETH collateral decoded cleanly")
	}
	lg = goldenGainsWethOpen()
	lg.Data = replaceWord(lg.Data, gainsWordCollateralAmount,
		"000000000000000000000000000000000000000000000000002dacb0f664c400") // one decimal off
	if _, _, err := decodeGainsExecution(lg, gainsArbDecimals); err == nil {
		t.Fatal("a collateral word an order of magnitude off decoded cleanly")
	}
}

// A zero second encoding is not a pass. If positionSizeToken or openPrice
// lands on a zero word the layout has drifted, and the log is refused.
func TestGainsDecode_ZeroSecondEncodingIsRefused(t *testing.T) {
	lg := goldenGainsEthLiquidation()
	lg.Data = replaceWord(lg.Data, gainsWordPositionSizeToken, zeroWord)
	_, _, err := decodeGainsExecution(lg, gainsArbDecimals)
	if err == nil {
		t.Fatal("a zero positionSizeToken decoded cleanly; the cross-check was skipped")
	}
	if !strings.Contains(err.Error(), "cross-check unavailable") {
		t.Fatalf("error = %v, want the unavailable cross-check refusal", err)
	}
}
