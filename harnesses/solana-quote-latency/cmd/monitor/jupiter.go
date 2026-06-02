package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// JupiterProvider quotes USDC -> tokenOut on Jupiter's public lite quote
// endpoint for a fixed 100 USDC notional. Rotating tokenOut every tick from a
// long-tail volume window defeats Jupiter's edge cache for popular pairs (SOL,
// USDT, CBBTC) so the bench measures the routing search rather than a CDN hit.
type JupiterProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewJupiterProvider(region, apiKey string) *JupiterProvider {
	return &JupiterProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *JupiterProvider) Slug() string { return "jupiter" }

const (
	jupiterQuoteEndpoint = "https://lite-api.jup.ag/swap/v1/quote"
	solMint              = "So11111111111111111111111111111111111111112"
	usdcMint             = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	canonicalUsdcRaw     = "100000000" // 100 USDC, 6 decimals
	canonicalUsdcWhole   = "100"
	canonicalSlippageBps = "100" // 1% - long-tail tokens need wider tolerance
	canonicalSlippagePct = "1"   // same 1% expressed as percent for APIs that take percent
)

type jupiterQuoteResp struct {
	OutAmount    string `json:"outAmount"`
	ErrorCode    string `json:"errorCode"`
	ErrorMessage string `json:"error"`
}

func (p *JupiterProvider) Probe(ctx context.Context, tokenOut TrendingToken) (int64, bool, error) {
	q := url.Values{}
	q.Set("inputMint", usdcMint)
	q.Set("outputMint", tokenOut.Mint)
	q.Set("amount", canonicalUsdcRaw)
	q.Set("slippageBps", canonicalSlippageBps)

	fullURL := jupiterQuoteEndpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "request_build")
		return 0, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if p.apiKey != "" {
		req.Header.Set("X-API-Key", p.apiKey)
	}

	start := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		errType := "network"
		if errors.Is(err, context.DeadlineExceeded) {
			errType = "timeout"
		}
		RecordOtherError(p.Slug(), p.region, errType)
		return 0, false, fmt.Errorf("jupiter http: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordThrottled(p.Slug(), p.region)
		return 0, false, fmt.Errorf("jupiter http 429")
	case http.StatusUnauthorized, http.StatusForbidden:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordAuthError(p.Slug(), p.region)
		return 0, false, fmt.Errorf("jupiter http %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "read_body")
		return 0, false, fmt.Errorf("read body: %w", err)
	}

	// Jupiter returns HTTP 400 with errorCode "COULD_NOT_FIND_ANY_ROUTE" for
	// tokens it can't route. That's a liquidity gap, not a server error, so it
	// goes on the no-route counter and is excluded from the latency histogram.
	if resp.StatusCode == http.StatusBadRequest {
		var parsed jupiterQuoteResp
		_ = json.Unmarshal(body, &parsed)
		if isNoRouteSignal(parsed.ErrorCode, parsed.ErrorMessage) {
			RecordNoRoute(p.Slug(), p.region)
			return 0, false, fmt.Errorf("jupiter no route for %s", tokenOut.Symbol)
		}
		RecordOtherError(p.Slug(), p.region, "http_400")
		return 0, false, fmt.Errorf("jupiter http 400: %s", parsed.ErrorMessage)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("jupiter http %d", resp.StatusCode)
	}

	var parsed jupiterQuoteResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		RecordOtherError(p.Slug(), p.region, "parse")
		return 0, false, fmt.Errorf("parse: %w", err)
	}
	if parsed.OutAmount == "" {
		RecordNoRoute(p.Slug(), p.region)
		return 0, false, fmt.Errorf("jupiter empty outAmount for %s", tokenOut.Symbol)
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}

// isNoRouteSignal classifies a provider error as "the token doesn't have a
// quotable path on this provider" (vs server error, validation error, auth).
//
// Concrete shapes verified against each provider's actual responses (see
// agent deep-test in PR description):
//   - Jupiter HTTP 400 → errorCode NO_ROUTES_FOUND | TOKEN_NOT_TRADABLE
//   - Mobula HTTP 200 → error "No route found" OR "Token not found: ..."
//   - OpenOcean HTTP 200 wrapper → handled separately by inspecting payload
//     (outAmount=="0" || dexId<0 || path==null). No string signal.
//   - Raydium HTTP 200 success:false → msg INSUFFICIENT_LIQUIDITY | ROUTE_NOT_FOUND
func isNoRouteSignal(code, msg string) bool {
	upper := strings.ToUpper(code) + " " + strings.ToUpper(msg)
	low := strings.ToLower(msg)
	if strings.Contains(upper, "COULD_NOT_FIND_ANY_ROUTE") ||
		strings.Contains(upper, "INSUFFICIENT_LIQUIDITY") ||
		strings.Contains(upper, "NO_ROUTE") || // matches NO_ROUTE, NO_ROUTES, NO_ROUTES_FOUND
		strings.Contains(upper, "ROUTE_NOT_FOUND") ||
		strings.Contains(upper, "TOKEN_NOT_TRADABLE") {
		return true
	}
	return strings.Contains(low, "no route") ||
		strings.Contains(low, "no routes") ||
		strings.Contains(low, "could not find") ||
		strings.Contains(low, "insufficient liquidity") ||
		strings.Contains(low, "route not found") ||
		strings.Contains(low, "not tradable") ||
		strings.Contains(low, "token not found")
}
