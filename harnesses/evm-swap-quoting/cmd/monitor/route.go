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

// RouteProvider hits partners.route.fun/quote, the Route v2 router for
// Robinhood Chain. Requires ROUTE_API_KEY as a Bearer token (quote-only key,
// issued for OpenChainBench). Query params are `in`, `out` and `amount`
// (smallest unit). Native ETH is the zero address. Robinhood Chain only.
type RouteProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewRouteProvider(region, apiKey string) *RouteProvider {
	return &RouteProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *RouteProvider) Slug() string { return "route" }

func (p *RouteProvider) Supports(chainId int) bool { return chainId == 4663 }

func (p *RouteProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	q := url.Values{}
	q.Set("in", strings.ToLower(mapNative(pair.TokenIn, ZeroAddress)))
	q.Set("out", strings.ToLower(mapNative(pair.TokenOut, ZeroAddress)))
	q.Set("amount", pair.AmountWei)
	endpoint := "https://partners.route.fun/quote?" + q.Encode()

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return 0, false, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	ms := time.Since(t0).Milliseconds()

	switch {
	case resp.StatusCode == 429:
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("429")
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		RecordAuthError(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("auth status=%d", resp.StatusCode)
	case resp.StatusCode == 404 || resp.StatusCode == 422:
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route status=%d", resp.StatusCode)
	case resp.StatusCode != 200:
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		OK        bool   `json:"ok"`
		AmountOut string `json:"amountOut"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if !r.OK || r.AmountOut == "" || r.AmountOut == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
