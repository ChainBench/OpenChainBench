package main

import (
	"strings"
	"testing"
)

// WETH collateral (index 2, 18 decimals). collateralPriceUsd at execution
// is 2200 while the position was opened when the collateral was worth more,
// so collateral x leverage x execution price and positionSizeToken x
// openPrice legitimately differ by the collateral's own move. An 18% gap
// must decode; a 10x scale error must still be refused.
func TestGainsDecode_VolatileCollateralUsesLooseTolerance(t *testing.T) {
	lg := goldenGainsEthLiquidation()
	// 10 WETH of collateral at 5x = 50 ETH of position.
	lg.Data = replaceWord(lg.Data, gainsWordCollateralIndex,
		"0000000000000000000000000000000000000000000000000000000000000002")
	lg.Data = replaceWord(lg.Data, gainsWordCollateralAmount,
		"0000000000000000000000000000000000000000000000008ac7230489e80000") // 10e18
	lg.Data = replaceWord(lg.Data, gainsWordLeverage,
		"0000000000000000000000000000000000000000000000000000000000001388") // 5000
	// openPrice 2673.125 (unchanged), positionSizeToken 50 ETH.
	lg.Data = replaceWord(lg.Data, gainsWordPositionSizeToken,
		"000000000000000000000000000000000000000000000002b5e3af16b1880000") // 50e18
	// collateralPriceUsd at execution 2200.00 (1e8): 18% below open.
	lg.Data = replaceWord(lg.Data, gainsWordCollateralPriceUS,
		"0000000000000000000000000000000000000000000000000000003338a0f800") // 220000000000

	ev, matched, err := decodeGainsLimitExecuted(lg, 1, 509189851, 1790500000000, gainsArbitrumBlockMs, gainsArbDecimals)
	if err != nil || !matched {
		t.Fatalf("a real WETH-collateral liquidation was refused: matched=%v err=%v", matched, err)
	}
	// 10 x 5 x 2200 = 110,000 USD at execution price.
	if ev.NotionalUSD < 109900 || ev.NotionalUSD > 110100 {
		t.Errorf("notional = %.2f, want about 110000", ev.NotionalUSD)
	}

	// Same log with leverage read ten times too large: 50,000 x.
	lg.Data = replaceWord(lg.Data, gainsWordLeverage,
		"000000000000000000000000000000000000000000000000000000000000c350") // 50000
	if _, _, err := decodeGainsLimitExecuted(lg, 1, 509189851, 1790500000000, gainsArbitrumBlockMs, gainsArbDecimals); err == nil {
		t.Fatal("a 10x scale error on volatile collateral decoded cleanly")
	}
}

// A zero second encoding is not a pass. If positionSizeToken or openPrice
// lands on a zero word the layout has drifted, and the log is refused.
func TestGainsDecode_ZeroSecondEncodingIsRefused(t *testing.T) {
	lg := goldenGainsEthLiquidation()
	lg.Data = replaceWord(lg.Data, gainsWordPositionSizeToken, zeroWord)
	_, _, err := decodeGainsLimitExecuted(lg, 1, 509189851, 1790500000000, gainsArbitrumBlockMs, gainsArbDecimals)
	if err == nil {
		t.Fatal("a zero positionSizeToken decoded cleanly; the cross-check was skipped")
	}
	if !strings.Contains(err.Error(), "cross-check unavailable") {
		t.Fatalf("error = %v, want the unavailable cross-check refusal", err)
	}
}
