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

func (p *ZeroExProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
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
		return 0, false, err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	if resp.StatusCode == 429 {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("429")
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		RecordAuthError(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		BuyAmount string `json:"buyAmount"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if r.BuyAmount == "" || r.BuyAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
