package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// ZeroExProvider hits api.0x.org/swap/permit2/quote.
// Free signup at dashboard.0x.org. Header: 0x-api-key + 0x-version: v2.
// Single endpoint for all chains, chainId in query.
type ZeroExProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewZeroExProvider(region, apiKey string) *ZeroExProvider {
	return &ZeroExProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *ZeroExProvider) Slug() string { return "0x" }

func (p *ZeroExProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 81457, 5000, 59144, 80094, 130:
		return true
	}
	return false
}

func (p *ZeroExProvider) Probe(ctx context.Context, pair TestPair) (Quote, error) {
	q := url.Values{}
	q.Set("chainId", fmt.Sprintf("%d", pair.ChainId))
	q.Set("sellToken", pair.TokenIn)
	q.Set("buyToken", pair.TokenOut)
	q.Set("sellAmount", pair.AmountWei)
	q.Set("taker", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	endpoint := "https://api.0x.org/swap/permit2/quote?" + q.Encode()

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("0x-api-key", p.apiKey)
	req.Header.Set("0x-version", "v2")

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
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		RecordAuthError(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return failed(), fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		BuyAmount   string `json:"buyAmount"`
		BlockNumber string `json:"blockNumber"`
		// 0x states its cut in buy-token units rather than a percentage.
		// Measured 2026-10-19 it came to 15.0 bps, against an observed
		// shortfall of 16.3 bps versus the best quote on the same pair.
		Fees struct {
			ZeroExFee *struct {
				Amount string `json:"amount"`
				Token  string `json:"token"`
			} `json:"zeroExFee"`
		} `json:"fees"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), err
	}
	if r.BuyAmount == "" || r.BuyAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("no_route")
	}
	quote := okQuote(ms, r.BuyAmount)
	if n, err := strconv.ParseUint(r.BlockNumber, 10, 64); err == nil {
		quote.Block = n
	}
	// The fee is quoted in the buy token, so it only converts to bps against
	// the buy amount. big.Float because both sides exceed int64 on an
	// 18-decimal output.
	if r.Fees.ZeroExFee != nil && r.Fees.ZeroExFee.Amount != "" {
		fee, okF := new(big.Float).SetString(r.Fees.ZeroExFee.Amount)
		out, okO := new(big.Float).SetString(r.BuyAmount)
		if okF && okO && out.Sign() > 0 {
			bps, _ := new(big.Float).Quo(fee, out).Float64()
			quote.FeeBps = bps * 10000
		}
	}
	return quote, nil
}
