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

// OneInchProvider hits api.1inch.dev/swap/v6.0/<chainId>/quote.
// Free signup at portal.1inch.dev (100k req/month, 1 RPS).
// Bearer token auth. Amount in wei.
type OneInchProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewOneInchProvider(region, apiKey string) *OneInchProvider {
	return &OneInchProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *OneInchProvider) Slug() string { return "1inch" }

func (p *OneInchProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 250, 100, 324, 59144:
		return true
	}
	return false
}

func (p *OneInchProvider) Probe(ctx context.Context, pair TestPair) (Quote, error) {
	q := url.Values{}
	q.Set("src", pair.TokenIn)
	q.Set("dst", pair.TokenOut)
	q.Set("amount", pair.AmountWei)
	endpoint := fmt.Sprintf("https://api.1inch.dev/swap/v6.0/%d/quote?%s", pair.ChainId, q.Encode())

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
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
		DstAmount string `json:"dstAmount"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), err
	}
	if r.DstAmount == "" || r.DstAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("no_route")
	}
	return okQuote(ms, r.DstAmount), nil
}
