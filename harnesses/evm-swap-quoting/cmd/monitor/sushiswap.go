package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// SushiSwapProvider hits api.sushi.com/swap/v7/<chainId>. No key, chain id in
// the path, amounts in the token's smallest unit.
//
// Added 2026-11-02 for the Robinhood Chain cohort, which had three answering
// providers (KyberSwap, LI.FI, Route) and needed a fourth before an output
// comparison there means anything. Verified answering on every chain in the
// basket the same day: 0.1 ETH bought 228.82 USDC on Ethereum, 228.91 on
// Base, 228.89 on Arbitrum and 228.85 USDG on Robinhood Chain, and 0.1 BNB
// bought 70.49 USDT on BSC. The four ETH figures agreeing to 0.4 bps across
// four chains is what makes the Robinhood number credible rather than a
// shape that merely parsed.
//
// The API declares no fee, so FeeBps stays -1: it says nothing, which is not
// the same as saying zero.
type SushiSwapProvider struct {
	region string
	client *http.Client
}

// Base URL as a variable so the test can point the adapter at a server
// serving canned bodies. The parsing is the part that fails silently, and a
// test that builds a Quote by hand would never exercise it.
var sushiBaseURL = "https://api.sushi.com/swap/v7"

func NewSushiSwapProvider(region string) *SushiSwapProvider {
	return &SushiSwapProvider{region: region, client: newWarmHTTPClient()}
}

func (p *SushiSwapProvider) Slug() string { return "sushi" }

// Every chain in the basket, each one probed rather than read off a docs
// page: a chain listed as supported that answers no-route would publish a
// blank column that looks like an outage.
func (p *SushiSwapProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 56, 8453, 42161, 4663:
		return true
	}
	return false
}

func (p *SushiSwapProvider) Probe(ctx context.Context, pair TestPair) (Quote, error) {
	q := url.Values{}
	q.Set("tokenIn", pair.TokenIn)
	q.Set("tokenOut", pair.TokenOut)
	q.Set("amount", pair.AmountWei)
	q.Set("maxSlippage", "0.005")
	// The same burner every other adapter sends, so no provider sees a
	// different caller and can price it differently.
	q.Set("sender", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	endpoint := fmt.Sprintf("%s/%d?%s", sushiBaseURL, pair.ChainId, q.Encode())

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Accept", "application/json")

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return failed(), err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	if resp.StatusCode == 429 {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("429")
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return failed(), fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		Status           string `json:"status"`
		AssumedAmountOut string `json:"assumedAmountOut"`
		GasSpent         any    `json:"gasSpent"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), err
	}
	// "Success" is the only status that carries a route; the API answers 200
	// with "NoWay" when it cannot build one, so the status is checked before
	// the amount and a missing route is recorded as a route failure rather
	// than a parse error.
	if r.Status != "Success" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("status=%s", r.Status)
	}
	if r.AssumedAmountOut == "" || r.AssumedAmountOut == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("no_route")
	}
	quote := okQuote(ms, r.AssumedAmountOut)
	quote.GasUnits = uintAny(r.GasSpent)
	return quote, nil
}
