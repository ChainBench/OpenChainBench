package main

// source_gains_volume_test.go: the three execution events that feed the
// Gains traded-notional denominator, pinned against real Arbitrum logs the
// way source_gains_golden_test.go pins the liquidation decode.
//
// The logs were read off the diamond on 2026-09-28 in blocks 509664638,
// 509665774 and 509666177. The topic hashes are pinned as literals from the
// chain, not recomputed, so a signature edit that changes the hash fails
// here before it silently matches nothing on the diamond, which is how
// Gains published zero for a month in 2026-09.

import (
	"strings"
	"testing"
)

func gainsWords(words ...string) string { return "0x" + strings.Join(words, "") }

func TestGainsTopics_MatchTheDiamond(t *testing.T) {
	want := map[string]string{
		"LimitExecuted":                "0x9c19bc42a9be820f3366fa0563f85e5c227966eaea4c45acd2f7cd868086a17d",
		"MarketExecuted":               "0xbdc1265da95238ea4c775f66ac8fe748af83982c4b356ac4d0c28a0f512c0a8b",
		"PositionSizeIncreaseExecuted": "0x3b7323355a4d9442335bf892bd48defd6c1647cb9c7170cb42f41dfba8e95aeb",
		"PositionSizeDecreaseExecuted": "0x38297f283e8c7319a10c298de767e2b919d8f506a0c15c6579fb7ad1c049cb43",
	}
	got := map[string]string{
		"LimitExecuted":                gainsLimitExecutedTopic,
		"MarketExecuted":               gainsMarketExecutedTopic,
		"PositionSizeIncreaseExecuted": gainsIncreaseTopic,
		"PositionSizeDecreaseExecuted": gainsDecreaseTopic,
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s topic = %s, want %s (as emitted by the Arbitrum diamond)", name, got[name], w)
		}
	}
}

// A market open: pair 117, 100x on 100 USDC, USDC at $0.99988281. The Trade
// tuple's second encoding is 47.99105 tokens at 208.372, $10,000.00.
func goldenGainsMarketOpen() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsMarketExecutedTopic,
			"0x000000000000000000000000656107e6600647554e50d6ad81bbb2a7dbb1a785",
			"0x0000000000000000000000000000000000000000000000000000000000000007",
		},
		Data: gainsWords(
			"000000000000000000000000656107e6600647554e50d6ad81bbb2a7dbb1a785", // w0  orderId.user
			"0000000000000000000000000000000000000000000000000000000000000009", // w1  orderId.index
			"000000000000000000000000656107e6600647554e50d6ad81bbb2a7dbb1a785", // w2  t.user
			"0000000000000000000000000000000000000000000000000000000000000007", // w3  t.index
			"0000000000000000000000000000000000000000000000000000000000000075", // w4  t.pairIndex 117
			"00000000000000000000000000000000000000000000000000000000000186a0", // w5  t.leverage 100000
			"0000000000000000000000000000000000000000000000000000000000000001", // w6  t.long
			"0000000000000000000000000000000000000000000000000000000000000001", // w7  t.isOpen
			"0000000000000000000000000000000000000000000000000000000000000003", // w8  t.collateralIndex 3 (USDC)
			"0000000000000000000000000000000000000000000000000000000000000000", // w9  t.tradeType
			"0000000000000000000000000000000000000000000000000000000005f5e100", // w10 t.collateralAmount 100 USDC
			"000000000000000000000000000000000000000000000000000001e5277d97eb", // w11 t.openPrice 208.372
			"000000000000000000000000000000000000000000000000000001eb45ccec00", // w12 t.tp
			"000000000000000000000000000000000000000000000000000001e443b35f00", // w13 t.sl
			"0000000000000000000000000000000000000000000000000000000000000000", // w14 t.isCounterTrade
			"0000000000000000000000000000000000000000000000029a02797917b6a36a", // w15 t.positionSizeToken 47.991
			"0000000000000000000000000000000000000000000000000000000000000000", // w16 t.__placeholder
			"0000000000000000000000000000000000000000000000000000000000000001", // w17 open = true
			"000000000000000000000000000000000000000000000000000001e52147eb60", // w18 oraclePrice
			"000000000000000000000000000000000000000000000000000001e5277d97eb", // w19 marketPrice
			"000000000000000000000000000000000000000000000000000001e11b2272cd", // w20 liqPrice
			"0000000000000000000000000000000000000000000000029a02797917b6a36a", // w21 priceImpact.positionSizeToken
			"0000000000000000000000000000000000000000000000000000000002faf080", // w22 priceImpact.fixedSpreadP
			"0000000000000000000000000000000000000000000000000000000000000000", // w23
			"0000000000000000000000000000000000000000000000000000000000000000", // w24
			"0000000000000000000000000000000000000000000000000000000002faf080", // w25 priceImpact.totalPriceImpactP
			"000000000000000000000000000000000000000000000000000001e5277d97eb", // w26 priceImpact.priceAfterImpact
			"0000000000000000000000000000000000000000000000000000000000000000", // w27 percentProfit
			"0000000000000000000000000000000000000000000000000000000000000000", // w28 amountSentToTrader
			"0000000000000000000000000000000000000000000000000000000005f5b339", // w29 collateralPriceUsd 0.99988281
		),
		BlockNumber: "0x1e60dd7e",
		TxHash:      "0xdb5ac4a3fdb09adab55aaf7d55958d2505e500f92691444d34ed0e895b9f9518",
		LogIndex:    "0x16",
	}
}

func TestGainsDecode_GoldenMarketOpen(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsMarketOpen(), gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("decode (ok=%v): %v", ok, err)
	}
	if ex.kind != gainsKindMarket || ex.liquidation {
		t.Fatalf("kind=%s liquidation=%v, want a market leg that is not a liquidation", ex.kind, ex.liquidation)
	}
	if ex.pair != 117 {
		t.Fatalf("pair = %d, want 117", ex.pair)
	}
	// 100 USDC x 100 x 0.99988281 = $9,998.83.
	if ex.notionalUSD < 9998 || ex.notionalUSD > 10000 {
		t.Fatalf("notional = %.2f, want about $9,998.83", ex.notionalUSD)
	}
	if ex.block != 509664638 || ex.key != "0xdb5ac4a3fdb09adab55aaf7d55958d2505e500f92691444d34ed0e895b9f9518:0x16" {
		t.Fatalf("block=%d key=%s", ex.block, ex.key)
	}

	// The same decode must refuse the log when a word slips: a 32-word body
	// claims to be a MarketExecuted it is not.
	lg := goldenGainsMarketOpen()
	lg.Data += zeroWord + zeroWord
	if _, _, err := decodeGainsExecution(lg, gainsArbDecimals); err == nil {
		t.Fatal("a 32-word MarketExecuted decoded cleanly")
	}
}

// An executed increase: pair 300, cancelReason 0, collateralDelta 3.362820
// USDC at leverageDelta 500x, so positionSizeCollateralDelta 1,681.41 USDC
// at $0.99989728.
func goldenGainsIncrease() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsIncreaseTopic,
			"0x0000000000000000000000000000000000000000000000000000000000000003",
			"0x000000000000000000000000a8b7121a49b324b14ee0fff24b527835eeb53619",
			"0x0000000000000000000000000000000000000000000000000000000000000005",
		},
		Data: gainsWords(
			"000000000000000000000000a8b7121a49b324b14ee0fff24b527835eeb53619", // w0  orderId.user
			"000000000000000000000000000000000000000000000000000000000000000c", // w1  orderId.index
			"0000000000000000000000000000000000000000000000000000000000000000", // w2  cancelReason 0
			"000000000000000000000000000000000000000000000000000000000000012c", // w3  pairIndex 300
			"0000000000000000000000000000000000000000000000000000000000000000", // w4  long
			"0000000000000000000000000000000000000000000000000002f040ee4cb900", // w5  oraclePrice
			"0000000000000000000000000000000000000000000000000000000005f5b8e0", // w6  collateralPriceUsd 0.99989728
			"0000000000000000000000000000000000000000000000000000000000335004", // w7  collateralDelta 3362820
			"000000000000000000000000000000000000000000000000000000000007a120", // w8  leverageDelta 500000
			"00000000000000000000000000000000000000000000000000000000643847d0", // w9  values.positionSizeCollateralDelta 1681410000
			"0000000000000000000000000000000000000000000000000000000080266580", // w10 values.existingPositionSizeCollateral
			"00000000000000000000000000000000000000000000000000000000e45ead50", // w11 values.newPositionSizeCollateral
			"000000000000000000000000000000000000000000000000000000000074ece4", // w12 values.newCollateralAmount
			"000000000000000000000000000000000000000000000000000000000007a120", // w13 values.newLeverage
			"000000000000000000000000000000000000000000000000004838d72ebf87bf", // w14 priceImpact.positionSizeToken
			"0000000000000000000000000000000000000000000000000000000000000000", // w15
			"0000000000000000000000000000000000000000000000000000000000000000", // w16
			"0000000000000000000000000000000000000000000000000000000000000000", // w17
			"0000000000000000000000000000000000000000000000000000000000000000", // w18
			"0000000000000000000000000000000000000000000000000002f040ee4cb900", // w19 priceImpact.priceAfterImpact
			"0000000000000000000000000000000000000000000000000000000000229ebd", // w20 existingPnlCollateral
			"000000000000000000000000000000000000000000000000000000008003c6c3", // w21 oldPosSizePlusPnlCollateral
			"0000000000000000000000000000000000000000000000000002f0b309981b3b", // w22 newOpenPrice
			"000000000000000000000000000000000000000000000000000000000005219a", // w23 openingFeesCollateral
			"0000000000000000000000000000000000000000000000000002f1f134867f35", // w24 existingLiqPrice
			"0000000000000000000000000000000000000000000000000002f198dd472b44", // w25 newLiqPrice
			"0000000000000000000000000000000000000000000000000000000000000000", // w26 isCounterTradeValidated
			"0000000000000000000000000000000000000000000000000000000000000000", // w27
			"0000000000000000000000000000000000000000000000000000000000000000", // w28
			"000000000000000000000000000000000000000000000000000000000006fac8", // w29 newEffectiveLeverage
		),
		BlockNumber: "0x1e60e1ee",
		TxHash:      "0xde51e4b4f86cc8aa1c85af63e5a3f4a1c19e3cb3d6fa56841fa26772b72fd465",
		LogIndex:    "0x1c",
	}
}

func TestGainsDecode_GoldenIncrease(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsIncrease(), gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("decode (ok=%v): %v", ok, err)
	}
	if ex.kind != gainsKindIncrease || ex.liquidation || ex.pair != 300 {
		t.Fatalf("kind=%s liquidation=%v pair=%d", ex.kind, ex.liquidation, ex.pair)
	}
	// 1,681.41 USDC x 0.99989728 = $1,681.24.
	if ex.notionalUSD < 1681 || ex.notionalUSD > 1682 {
		t.Fatalf("notional = %.2f, want about $1,681.24", ex.notionalUSD)
	}

	// The same resize refused by the contract (cancelReason 8, as two
	// neighbouring logs in the same block were) traded nothing.
	lg := goldenGainsIncrease()
	lg.Data = replaceWord(lg.Data, gainsResizeWordCancelReason,
		"0000000000000000000000000000000000000000000000000000000000000008")
	if _, ok, err := decodeGainsExecution(lg, gainsArbDecimals); err != nil || ok {
		t.Fatalf("a cancelled increase counted as a leg (ok=%v err=%v)", ok, err)
	}

	// A leverageDelta read ten times too large breaks the agreement with
	// positionSizeCollateralDelta and the log is refused, not published.
	lg = goldenGainsIncrease()
	lg.Data = replaceWord(lg.Data, gainsResizeWordLevDelta,
		"00000000000000000000000000000000000000000000000000000000004c4b40") // 5,000,000
	if _, _, err := decodeGainsExecution(lg, gainsArbDecimals); err == nil {
		t.Fatal("an increase whose deltas disagree decoded cleanly")
	}
}

// An executed decrease that is a leverage update: pair 105, cancelReason 0,
// positionSizeCollateralDelta 6,883.29 USDC out of an existing 9,180.81, at
// $0.99988346.
func goldenGainsDecrease() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsDecreaseTopic,
			"0x0000000000000000000000000000000000000000000000000000000000000003",
			"0x0000000000000000000000009191b0ae7065921f95be0aa6843cbec2fba4141b",
			"0x000000000000000000000000000000000000000000000000000000000000002d",
		},
		Data: gainsWords(
			"0000000000000000000000009191b0ae7065921f95be0aa6843cbec2fba4141b", // w0  orderId.user
			"000000000000000000000000000000000000000000000000000000000000008f", // w1  orderId.index
			"0000000000000000000000000000000000000000000000000000000000000000", // w2  cancelReason 0
			"0000000000000000000000000000000000000000000000000000000000000069", // w3  pairIndex 105
			"0000000000000000000000000000000000000000000000000000000000000001", // w4  long
			"000000000000000000000000000000000000000000000000000001dca8da1f20", // w5  oraclePrice
			"0000000000000000000000000000000000000000000000000000000005f5b37a", // w6  collateralPriceUsd 0.99988346
			"0000000000000000000000000000000000000000000000000000000000000000", // w7  collateralDelta 0
			"0000000000000000000000000000000000000000000000000000000000000b9c", // w8  leverageDelta 2972
			"0000000000000000000000000000000000000000000000000000000000000001", // w9  values.isLeverageUpdate
			"000000000000000000000000000000000000000000000000000000019a46ad67", // w10 values.positionSizeCollateralDelta 6883290471
			"00000000000000000000000000000000000000000000000000000002233805f2", // w11 values.existingPositionSizeCollateral 9180808690
			"000000000000000000000000000000000000000000000000000001d420ae3b49", // w12 values.existingLiqPrice
			"000000000000000000000000000000000000000000000000000001bb36cdd5c3", // w13 values.newLiqPrice
			"0000000000000000000000000000000000000000000000016f9c5e77673d536e", // w14 priceImpact.positionSizeToken
			"0000000000000000000000000000000000000000000000000000000000000000", // w15
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1fd6278", // w16
			"00000000000000000000000000000000000000000000000000000000020705d1", // w17
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffe4046849", // w18
			"000000000000000000000000000000000000000000000000000001dc6f908c2c", // w19 priceImpact.priceAfterImpact
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffff3bd5b0d722", // w20 existingPnlPercent
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffa8cc62d6", // w21 partialRawPnlCollateral
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffa8b03fd0", // w22 partialNetPnlCollateral
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffa8cc62d6", // w23 pnlToRealizeCollateral
			"00000000000000000000000000000000000000000000000000000000003333d3", // w24 closingFeeCollateral
			"0000000000000000000000000000000000000000000000000000000089af3951", // w25 totalAvailableCollateralInDiamond
			"0000000000000000000000000000000000000000000000000000000000000000", // w26 availableCollateralInDiamond
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffa8f5db94", // w27 collateralSentToTrader
			"000000000000000000000000000000000000000000000000000000008a0c1100", // w28 newCollateralAmount
			"00000000000000000000000000000000000000000000000000000000000003e0", // w29 newLeverage
		),
		BlockNumber: "0x1e60e381",
		TxHash:      "0x324fbf289563cfc3a6c784fffaf8bb62847b3091b93a65f88d3a31ebdd5c1cfe",
		LogIndex:    "0x1e",
	}
}

func TestGainsDecode_GoldenDecrease(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsDecrease(), gainsArbDecimals)
	if err != nil || !ok {
		t.Fatalf("decode (ok=%v): %v", ok, err)
	}
	if ex.kind != gainsKindDecrease || ex.liquidation || ex.pair != 105 {
		t.Fatalf("kind=%s liquidation=%v pair=%d", ex.kind, ex.liquidation, ex.pair)
	}
	// 6,883.29 USDC x 0.99988346 = $6,882.49.
	if ex.notionalUSD < 6882 || ex.notionalUSD > 6883 {
		t.Fatalf("notional = %.2f, want about $6,882.49", ex.notionalUSD)
	}

	// A delta larger than the position held is a word that is not the
	// delta, and the log is refused.
	lg := goldenGainsDecrease()
	lg.Data = replaceWord(lg.Data, gainsDecreaseWordExistingPos,
		"0000000000000000000000000000000000000000000000000000000000000001")
	if _, _, err := decodeGainsExecution(lg, gainsArbDecimals); err == nil {
		t.Fatal("a decrease larger than its position decoded cleanly")
	}
}

// The liquidation golden log goes through the generic decode as a
// liquidation of pair 1, and a log under a topic the scan does not ask for
// is an error rather than a silent zero.
func TestGainsDecode_GenericRoutesByTopic(t *testing.T) {
	ex, ok, err := decodeGainsExecution(goldenGainsEthLiquidation(), gainsArbDecimals)
	if err != nil || !ok || !ex.liquidation || ex.pair != 1 || ex.kind != gainsKindLimit {
		t.Fatalf("liquidation via generic decode: ok=%v err=%v ex=%+v", ok, err, ex)
	}
	lg := goldenGainsEthLiquidation()
	lg.Topics[0] = "0x7cc135e0cebb02c3480ae5d74d377283180a2601f8f644edf7987b009316c63a"
	if _, _, err := decodeGainsExecution(lg, gainsArbDecimals); err == nil {
		t.Fatal("an unknown topic decoded cleanly")
	}
}
