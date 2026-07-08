package main

import (
	"encoding/json"
	"strconv"
	"testing"
)

// Live response captured 2026-07-08 from
// GET https://app.across.to/api/swap/approval?tradeType=exactInput&amount=300000000
//   &inputToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&originChainId=8453
//   &outputToken=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9&destinationChainId=42161
// (Base USDC to Arbitrum USDT, the cross-asset corridor). Trimmed to the
// fields the harness decodes; values are verbatim.
const acrossLiveSwapResponse = `{"crossSwapType":"anyToBridgeable","fees":{"total":{"amount":"1099243","amountUsd":"1.099199999999999955","token":{"decimals":6,"symbol":"USDC","address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","name":"USD Coin","chainId":8453},"pct":"3664146565862634","details":{"type":"total-breakdown","swapImpact":{"amount":"-158088","amountUsd":"-0.15808239547799996","token":{"decimals":6,"symbol":"USDC","address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","name":"USD Coin","chainId":8453},"pct":"-526962396755870"},"app":{"amount":"0","amountUsd":"0.0","token":{"decimals":6,"symbol":"USDT","address":"0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9","name":"Tether USD","chainId":42161},"pct":"0"},"bridge":{"amount":"1258386","amountUsd":"1.257282395477999914","token":{"address":"0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2","decimals":6,"symbol":"USDT","chainId":8453},"pct":"4191108962618505","details":{"type":"across","lp":{"amount":"498437","amountUsd":"0.497999870750999996","token":{"address":"0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2","decimals":6,"symbol":"USDT","chainId":8453},"pct":"1660065971808872"},"relayerCapital":{"amount":"749162","amountUsd":"0.748504984925999928","token":{"address":"0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2","decimals":6,"symbol":"USDT","chainId":8453},"pct":"2495116421076843"},"destinationGas":{"amount":"6210800385526","amountUsd":"0.010777539801","token":{"chainId":42161,"address":"0x0000000000000000000000000000000000000000","decimals":18,"symbol":"ETH"},"pct":"35926569732789"}}}}}},"inputAmount":"300000000","expectedOutputAmount":"299156590","minOutputAmount":"298410564","expectedFillTime":2}`

func TestAcrossSwapResponseParsing(t *testing.T) {
	var out AcrossSwapResponse
	if err := json.Unmarshal([]byte(acrossLiveSwapResponse), &out); err != nil {
		t.Fatalf("decode live across response: %v", err)
	}
	costUsd, err := strconv.ParseFloat(out.Fees.Total.AmountUsd, 64)
	if err != nil {
		t.Fatalf("parse fees.total.amountUsd: %v", err)
	}
	// $1.0992 all-in on a $300 notional = 0.366 percent. Sanity-bound rather
	// than exact-match so refreshing the fixture with a new live capture
	// does not require editing the assertion.
	if costUsd <= 0 || costUsd > 30 {
		t.Fatalf("cost out of sane range: %v", costUsd)
	}
	costPct := costUsd / 300 * 100
	if costPct <= 0 || costPct > 10 {
		t.Fatalf("cost pct out of sane range: %v", costPct)
	}
	bridgeFeeUsd, err := strconv.ParseFloat(out.Fees.Total.Details.Bridge.AmountUsd, 64)
	if err != nil {
		t.Fatalf("parse bridge fee: %v", err)
	}
	if bridgeFeeUsd <= 0 {
		t.Fatalf("bridge fee should be positive, got %v", bridgeFeeUsd)
	}
	gasUsd, err := strconv.ParseFloat(out.Fees.Total.Details.Bridge.Details.DestinationGas.AmountUsd, 64)
	if err != nil {
		t.Fatalf("parse destination gas: %v", err)
	}
	if gasUsd <= 0 {
		t.Fatalf("destination gas should be positive, got %v", gasUsd)
	}
	if out.ExpectedFillTime <= 0 {
		t.Fatalf("expectedFillTime should be positive, got %v", out.ExpectedFillTime)
	}
	if out.Message != "" || out.ErrorID != "" {
		t.Fatalf("unexpected error fields: %q %q", out.Message, out.ErrorID)
	}
}

func TestAcrossRouteSupport(t *testing.T) {
	routes := GetTestRoutes()
	supported := map[string]bool{}
	for _, r := range routes {
		ok := acrossChainID(r.FromChain) != 0 && acrossChainID(r.ToChain) != 0 &&
			acrossSupportedToken(r.FromChain, r.FromToken) && acrossSupportedToken(r.ToChain, r.ToToken)
		supported[r.Name] = ok
	}
	for name, want := range map[string]bool{
		"USDC_SOL_BASE":        true,  // Sol USDC to Base USDC
		"USDC_BASE_USDT_ARB":   true,  // cross-asset via Swap API
		"USDT_ARB_USDC_SOL":    true,  // cross-asset via Swap API
		"TRUMP_SOL_BRETT_BASE": false, // calibration route, excluded
		"USDC_ARB_HYPERCORE":   false, // Across 999 is HyperEVM, not a HyperCore credit
	} {
		if supported[name] != want {
			t.Errorf("route %s: supported=%v, want %v", name, supported[name], want)
		}
	}
}
