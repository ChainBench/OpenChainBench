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

// MobulaProvider hits api.mobula.io/api/2/swap/quoting on every supported chain.
// Auth header is "Authorization: <key>" — NOT "Bearer <key>". Confirmed live.
// Amount param is HUMAN-readable (e.g. amount=1 for 1 ETH, not wei).
// Native ETH/BNB sentinel: 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE (canonical).
type MobulaProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewMobulaProvider(region, apiKey string) *MobulaProvider {
	return &MobulaProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *MobulaProvider) Slug() string { return "mobula" }

func (p *MobulaProvider) Supports(chainId int) bool {
	// Mobula's docs list: 1, 10, 56, 137, 8453, 42161, 43114 + solana (alpha).
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114:
		return true
	}
	return false
}

func (p *MobulaProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	q := url.Values{}
	q.Set("tokenIn", pair.TokenIn)
	q.Set("tokenOut", pair.TokenOut)
	q.Set("amount", pair.AmountHuman)
	q.Set("chainId", fmt.Sprintf("%d", pair.ChainId))
	q.Set("walletAddress", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	endpoint := "https://api.mobula.io/api/2/swap/quoting?" + q.Encode()

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", p.apiKey) // no "Bearer" prefix

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
		Data struct {
			AmountOutTokens string `json:"amountOutTokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if r.Data.AmountOutTokens == "" || r.Data.AmountOutTokens == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
