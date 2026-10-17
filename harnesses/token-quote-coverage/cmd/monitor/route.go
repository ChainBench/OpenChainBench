package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const routeUSDGRobinhood = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"

// RouteProvider hits partners.route.fun/quote, the Route v2 router for
// Robinhood Chain. Requires ROUTE_API_KEY as a Bearer token. Robinhood only.
// A no-route answer is HTTP 200 with ok=false.
type RouteProvider struct {
	apiKey string
	client *http.Client
}

func NewRouteProvider(apiKey string) *RouteProvider {
	return &RouteProvider{apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *RouteProvider) Slug() string { return "route" }

func (p *RouteProvider) SupportsChain(chain string) bool { return chain == "robinhood" }

func (p *RouteProvider) Quote(ctx context.Context, token Token) (ok bool) {
	if token.Chain != "robinhood" {
		RecordProbeDetailed(p.Slug(), token.Venue, token.Chain, false, false)
		return false
	}

	q := url.Values{}
	q.Set("in", routeUSDGRobinhood)
	q.Set("out", strings.ToLower(token.Address))
	q.Set("amount", "1000000") // 1 USDG (6 decimals)
	endpoint := "https://partners.route.fun/quote?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbeDetailed(p.Slug(), token.Venue, token.Chain, false, false)
		return false
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[route] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbeDetailed(p.Slug(), token.Venue, token.Chain, false, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[route] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbeDetailed(p.Slug(), token.Venue, token.Chain, false, false)
		return false
	}

	var r struct {
		OK        bool   `json:"ok"`
		AmountOut string `json:"amountOut"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[route] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbeDetailed(p.Slug(), token.Venue, token.Chain, true, false)
		return false
	}

	ok = r.OK && r.AmountOut != "" && r.AmountOut != "0"
	RecordProbeDetailed(p.Slug(), token.Venue, token.Chain, true, ok)
	return ok
}
