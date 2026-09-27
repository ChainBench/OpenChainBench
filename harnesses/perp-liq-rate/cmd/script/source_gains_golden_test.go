package main

// source_gains_golden_test.go — the Gains decode pinned against real logs
// pulled off the Arbitrum diamond, word for word.
//
// The 2026-09-27 audit read 36% on Gains and 491% over the trailing week,
// and the first suspicion was the decode: a leverage field at the wrong
// precision, cancelReason no longer meaning liquidation, or the same close
// counted several times. None of that was true. The words below are tx
// 0x417d6d29...c8d8 log 0x6d in Arbitrum block 509189851, and the event says
// a 90,519.73 USDC position at 136.337x on pair 1 was liquidated for
// $12.34M of notional. Two independent encodings inside the same event agree
// on that figure to 0.02%, and every scale factor is confirmed against
// trading-variables: groups[0] (crypto) maxLeverage 200000 fixes leverage at
// 1e3, collateralConfig.decimals fixes USDC at 6, and collateralPriceUsd
// 99987055/1e8 = 0.99987 matches the 0.99987308 the backend reports.
//
// So this file exists to stop a future change from "fixing" a number that is
// correct, and to fail loudly if the diamond's ABI moves under us.

import (
	"strings"
	"testing"
)

// gainsLogWords joins 32-byte words into the data field of an eth log.
func gainsLogWords(words ...string) string {
	if len(words) != gainsLimitExecutedWords {
		panic("golden log must have exactly 32 words")
	}
	return "0x" + strings.Join(words, "")
}

const (
	zeroWord = "0000000000000000000000000000000000000000000000000000000000000000"
	oneWord  = "0000000000000000000000000000000000000000000000000000000000000001"
)

// The real liquidation: pair 1 (ETH), 136.337x, 90,519.729023 USDC, USDC at
// $0.99987055, positionSizeToken 4617.318981580534 ETH at openPrice 2673.125.
func goldenGainsEthLiquidation() ethLog {
	return ethLog{
		Address: gainsArbitrumDiamond,
		Topics: []string{
			gainsLimitExecutedTopic,
			"0x000000000000000000000000abf68ea28e2522726f53b6413b87ef7067fdf21a",
			"0x0000000000000000000000000000000000000000000000000000000000000280",
			"0x0000000000000000000000000000000000000000000000000000000000000000",
		},
		Data: gainsLogWords(
			zeroWord, // w0  orderId.user
			zeroWord, // w1  orderId.index
			"000000000000000000000000abf68ea28e2522726f53b6413b87ef7067fdf21a", // w2  t.user
			"0000000000000000000000000000000000000000000000000000000000000280", // w3  t.index 640
			oneWord, // w4  t.pairIndex = 1 (ETH/USD)
			"0000000000000000000000000000000000000000000000000000000000021491", // w5  t.leverage 136337
			oneWord, // w6  t.long
			oneWord, // w7  t.isOpen
			"0000000000000000000000000000000000000000000000000000000000000003", // w8  t.collateralIndex 3 (USDC)
			zeroWord, // w9  t.tradeType
			"000000000000000000000000000000000000000000000000000000151365737f", // w10 t.collateralAmount 90519729023
			"0000000000000000000000000000000000000000000000000000184fdab7e855", // w11 t.openPrice 2673.1250968661
			zeroWord, // w12 t.tp
			zeroWord, // w13 t.sl
			zeroWord, // w14 t.isCounterTrade = false
			"0000000000000000000000000000000000000000000000fa4e2c4e24a02a236e", // w15 t.positionSizeToken 4617.318981580534
			zeroWord, // w16 t.__placeholder
			"0000000000000000000000002a3021ea2fb3434d5bcf76c92837a750845a2379", // w17 triggerCaller
			"0000000000000000000000000000000000000000000000000000000000000006", // w18 orderType = LIQ_CLOSE
			"00000000000000000000000000000000000000000000000000001844bac6b4e2", // w19 oraclePrice
			"00000000000000000000000000000000000000000000000000001844bac6b4e2", // w20 marketPrice
			"00000000000000000000000000000000000000000000000000001844bac6b4e2", // w21 liqPrice
			zeroWord, zeroWord, zeroWord, zeroWord, zeroWord, zeroWord, // w22-27 priceImpact
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffc742aed816", // w28 percentProfit
			zeroWord, // w29 amountSentToTrader (nothing back on a liquidation)
			"0000000000000000000000000000000000000000000000000000000005f5ae6f", // w30 collateralPriceUsd 0.99987055
			oneWord, // w31 exactExecution
		),
		BlockNumber: "0x1e599edb",
		TxHash:      "0x417d6d29bdab261807060f38e9e4fa61b2c3e343653d01afbe929d1edf07c8b0",
		LogIndex:    "0x6d",
	}
}

var gainsArbDecimals = map[uint64]int{1: 18, 2: 18, 3: 6, 4: 18}

func TestGainsDecode_GoldenEthLiquidation(t *testing.T) {
	lg := goldenGainsEthLiquidation()
	latest := uint64(509189851)
	nowMs := int64(1790500000000)

	ev, matched, err := decodeGainsLimitExecuted(lg, 1, latest, nowMs, gainsArbitrumBlockMs, gainsArbDecimals)
	if err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if !matched {
		t.Fatal("pair 1 LIQ_CLOSE should match the ETH request")
	}
	// 90519.729023 USDC x 136.337 x 0.99987055.
	if ev.NotionalUSD < 12.33e6 || ev.NotionalUSD > 12.35e6 {
		t.Fatalf("notional = %.2f, want about $12.34M", ev.NotionalUSD)
	}
	if ev.Key != lg.TxHash+":"+lg.LogIndex {
		t.Fatalf("key = %q, want txHash:logIndex", ev.Key)
	}
	if ev.Bucket {
		t.Fatal("an on-chain log is an event, not a restatable bucket")
	}

	// A liquidation of a different pair must not land on this asset. The
	// two whale events were on pair 1; the BTC row read $169 the same day.
	if _, matched, err := decodeGainsLimitExecuted(lg, 0, latest, nowMs, gainsArbitrumBlockMs, gainsArbDecimals); err != nil || matched {
		t.Fatalf("pair 1 event matched a pair 0 request (matched=%v err=%v)", matched, err)
	}
}

// Anything other than LIQ_CLOSE is a limit, stop, take-profit or stop-loss
// execution and is not a liquidation. 154 of the 461 LimitExecuted logs in
// the 24h to 2026-09-27 were orderType 6; 307 were not.
func TestGainsDecode_NonLiquidationOrderTypes(t *testing.T) {
	for _, ot := range []string{
		"0000000000000000000000000000000000000000000000000000000000000002", // LIMIT_OPEN
		"0000000000000000000000000000000000000000000000000000000000000003", // STOP_OPEN
		"0000000000000000000000000000000000000000000000000000000000000004", // TP_CLOSE
		"0000000000000000000000000000000000000000000000000000000000000005", // SL_CLOSE
	} {
		lg := goldenGainsEthLiquidation()
		lg.Data = replaceWord(lg.Data, gainsWordOrderType, ot)
		_, matched, err := decodeGainsLimitExecuted(lg, 1, 509189851, 1790500000000, gainsArbitrumBlockMs, gainsArbDecimals)
		if err != nil {
			t.Fatalf("orderType %s: unexpected error %v", ot, err)
		}
		if matched {
			t.Fatalf("orderType %s counted as a liquidation", ot)
		}
	}
}

// The scale guard. Reading leverage at 1e18 instead of 1e3, or slipping a
// word, moves collateral x leverage away from positionSizeToken x openPrice
// and the log must be refused rather than published.
func TestGainsDecode_RefusesDisagreeingPositionSize(t *testing.T) {
	// Leverage ten times the real one: 1363370, so $123M of notional. It
	// stays under the 1e10 single-event ceiling, which means only the
	// cross-check can catch it.
	lg := goldenGainsEthLiquidation()
	lg.Data = replaceWord(lg.Data, gainsWordLeverage,
		"000000000000000000000000000000000000000000000000000000000014cdaa")
	_, matched, err := decodeGainsLimitExecuted(lg, 1, 509189851, 1790500000000, gainsArbitrumBlockMs, gainsArbDecimals)
	if err == nil {
		t.Fatalf("a 10x leverage scale error decoded cleanly (matched=%v)", matched)
	}
	if !strings.Contains(err.Error(), "position size disagrees") {
		t.Fatalf("error = %v, want the position-size cross-check to fire", err)
	}

	// A word slipped by one puts collateralAmount where openPrice belongs.
	lg3 := goldenGainsEthLiquidation()
	lg3.Data = replaceWord(lg3.Data, gainsWordCollateralAmount,
		"0000000000000000000000000000000000000000000000000000184fdab7e855")
	if _, _, err := decodeGainsLimitExecuted(lg3, 1, 509189851, 1790500000000, gainsArbitrumBlockMs, gainsArbDecimals); err == nil {
		t.Fatal("a slipped collateral word decoded cleanly")
	}

	// Collateral read with 18 decimals instead of 6 collapses the notional.
	lg2 := goldenGainsEthLiquidation()
	_, _, err = decodeGainsLimitExecuted(lg2, 1, 509189851, 1790500000000, gainsArbitrumBlockMs,
		map[uint64]int{3: 18})
	if err == nil {
		t.Fatal("wrong collateral decimals decoded cleanly")
	}
}

// replaceWord swaps the i-th 32-byte word of a 0x-prefixed data field.
func replaceWord(data string, i int, word string) string {
	body := strings.TrimPrefix(data, "0x")
	if len(word) != 64 {
		panic("word must be 64 hex chars")
	}
	return "0x" + body[:i*64] + word + body[(i+1)*64:]
}

// The word offsets are also pinned by a second, smaller real event: a 500x
// BTCDEGEN (pair 300) liquidation of 1.0 USDC in Arbitrum block 509454052,
// $499.94 of notional, positionSizeToken 0.005909995240444433 at 84602.437.
func TestGainsDecode_GoldenSmallDegenLiquidation(t *testing.T) {
	lg := goldenGainsEthLiquidation()
	lg.Data = replaceWord(lg.Data, gainsWordPairIndex,
		"000000000000000000000000000000000000000000000000000000000000012c") // 300
	lg.Data = replaceWord(lg.Data, gainsWordLeverage,
		"000000000000000000000000000000000000000000000000000000000007a120") // 500000
	lg.Data = replaceWord(lg.Data, gainsWordCollateralAmount,
		"00000000000000000000000000000000000000000000000000000000000f4240") // 1000000
	lg.Data = replaceWord(lg.Data, gainsWordOpenPrice,
		"00000000000000000000000000000000000000000000000000030174660b9080") // 84602.437
	lg.Data = replaceWord(lg.Data, gainsWordPositionSizeToken,
		"0000000000000000000000000000000000000000000000000014ff1bfeee5211") // 0.00590999524

	ev, matched, err := decodeGainsLimitExecuted(lg, 300, 509454052, 1790500000000, gainsArbitrumBlockMs, gainsArbDecimals)
	if err != nil || !matched {
		t.Fatalf("decode (matched=%v): %v", matched, err)
	}
	if ev.NotionalUSD < 499 || ev.NotionalUSD > 501 {
		t.Fatalf("notional = %.2f, want about $499.94", ev.NotionalUSD)
	}
}
