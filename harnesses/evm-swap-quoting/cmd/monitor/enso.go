package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// EnsoProvider hits api.enso.finance/api/v1/shortcuts/route.
// Anonymous endpoint has a shared 1rps bucket: harness cadence (1 call/min)
// usually fits but occasionally trips into 429 when another anonymous
// caller bursts at the same moment. Free tier with ENSO_API_KEY widens
// the bucket. If the key is unset we still hit anonymous and tolerate the
// ~20% throttle as documented noise (success gauge dips, but 230+ healthy
// samples per (chain, region) per 24h is enough for a stable p50.).
// Native sentinel: 0xEeee... (canonical).
type EnsoProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewEnsoProvider(region, apiKey string) *EnsoProvider {
	return &EnsoProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *EnsoProvider) Slug() string { return "enso" }

func (p *EnsoProvider) Supports(chainId int) bool {
	// Enso covers 14+ EVM chains, all V1 basket chains included.
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 100, 324, 8217, 59144, 81457, 5000:
		return true
	}
	return false
}

func (p *EnsoProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	q := url.Values{}
	q.Set("chainId", fmt.Sprintf("%d", pair.ChainId))
	q.Set("fromAddress", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	q.Set("tokenIn", pair.TokenIn)
	q.Set("tokenOut", pair.TokenOut)
	q.Set("amountIn", pair.AmountWei)
	endpoint := "https://api.enso.finance/api/v1/shortcuts/route?" + q.Encode()

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Accept", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return 0, false, err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	body, _ := io.ReadAll(resp.Body)

	// Enso returns 429 with a plain-text body "You've exceeded the request
	// limit of 1rps." instead of a structured JSON. Catch both forms.
	if resp.StatusCode == 429 || strings.Contains(string(body), "1rps") {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("429")
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		RecordAuthError(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("%d", resp.StatusCode)
	}
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}

	var r struct {
		AmountOut string `json:"amountOut"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if r.AmountOut == "" || r.AmountOut == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
