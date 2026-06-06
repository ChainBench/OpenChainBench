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

// OpenOceanProvider hits open-api.openocean.finance/v4/<chainId>/quote.
// Chain segment in URL is the NUMERIC chainId (not the slug).
// Amount is HUMAN-readable (e.g. 1 ETH = "1"). No-key.
// Slow provider (830ms-1.3s p50 observed) but robust.
type OpenOceanProvider struct {
	region string
	client *http.Client
}

func NewOpenOceanProvider(region string) *OpenOceanProvider {
	return &OpenOceanProvider{region: region, client: newWarmHTTPClient()}
}

func (p *OpenOceanProvider) Slug() string { return "openocean" }

func (p *OpenOceanProvider) Supports(chainId int) bool {
	// OpenOcean v4 supports 40+ chains, full V1 basket covered.
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 250, 5000, 59144:
		return true
	}
	return false
}

func (p *OpenOceanProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	q := url.Values{}
	q.Set("inTokenAddress", pair.TokenIn)
	q.Set("outTokenAddress", pair.TokenOut)
	q.Set("amount", pair.AmountHuman)
	q.Set("slippage", "1")
	q.Set("gasPrice", "10") // required on some chains; small number is fine for quote
	q.Set("account", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	endpoint := fmt.Sprintf("https://open-api.openocean.finance/v4/%d/quote?%s", pair.ChainId, q.Encode())

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
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		Code int `json:"code"`
		Data struct {
			OutAmount string `json:"outAmount"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if r.Code != 200 && r.Code != 0 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("api_code_%d", r.Code))
		return 0, false, fmt.Errorf("api_code=%d", r.Code)
	}
	if r.Data.OutAmount == "" || r.Data.OutAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
