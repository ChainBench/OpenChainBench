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

// LiFiProvider hits li.quest/v1/quote for same-chain swaps
// (fromChain == toChain). No-key on the free tier (200 req/2h IP-throttled).
// Cross-chain is supported but we only bench same-chain here.
type LiFiProvider struct {
	region string
	client *http.Client
}

func NewLiFiProvider(region string) *LiFiProvider {
	return &LiFiProvider{region: region, client: newWarmHTTPClient()}
}

func (p *LiFiProvider) Slug() string { return "lifi" }

func (p *LiFiProvider) Supports(chainId int) bool {
	// LI.FI supports 30+ EVM chains, the full V1 basket is covered.
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 250, 100, 324, 59144, 81457:
		return true
	}
	return false
}

func (p *LiFiProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	q := url.Values{}
	q.Set("fromChain", fmt.Sprintf("%d", pair.ChainId))
	q.Set("toChain", fmt.Sprintf("%d", pair.ChainId))
	q.Set("fromToken", pair.TokenIn)
	q.Set("toToken", pair.TokenOut)
	q.Set("fromAmount", pair.AmountWei)
	q.Set("fromAddress", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	endpoint := "https://li.quest/v1/quote?" + q.Encode()

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)

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
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 404 {
		// LI.FI returns 404 for no-route on same-chain pairs.
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route_404")
	}
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		Estimate struct {
			ToAmount string `json:"toAmount"`
		} `json:"estimate"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if r.Estimate.ToAmount == "" || r.Estimate.ToAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
