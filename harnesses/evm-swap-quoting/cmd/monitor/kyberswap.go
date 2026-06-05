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

// KyberSwapProvider hits aggregator-api.kyberswap.com/<slug>/api/v1/routes.
// No-key. Header `x-client-id: openchainbench` is optional (analytics only).
// Amount is in WEI / smallest unit. Chain is a SLUG in the URL.
// Fastest provider observed (170-460ms p50).
type KyberSwapProvider struct {
	region string
	client *http.Client
}

func NewKyberSwapProvider(region string) *KyberSwapProvider {
	return &KyberSwapProvider{region: region, client: newWarmHTTPClient()}
}

func (p *KyberSwapProvider) Slug() string { return "kyberswap" }

func (p *KyberSwapProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 250, 5000, 59144:
		return true
	}
	return false
}

func (p *KyberSwapProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	slug := ChainSlugFor(pair.ChainId)
	if slug == "" {
		return 0, false, fmt.Errorf("unsupported chain")
	}
	q := url.Values{}
	q.Set("tokenIn", pair.TokenIn)
	q.Set("tokenOut", pair.TokenOut)
	q.Set("amountIn", pair.AmountWei)
	q.Set("saveGas", "false")
	endpoint := fmt.Sprintf("https://aggregator-api.kyberswap.com/%s/api/v1/routes?%s", slug, q.Encode())

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("x-client-id", "openchainbench")

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
			RouteSummary struct {
				AmountOut string `json:"amountOut"`
			} `json:"routeSummary"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if r.Code != 0 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("api_code_%d", r.Code))
		return 0, false, fmt.Errorf("api_code=%d", r.Code)
	}
	if r.Data.RouteSummary.AmountOut == "" || r.Data.RouteSummary.AmountOut == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
