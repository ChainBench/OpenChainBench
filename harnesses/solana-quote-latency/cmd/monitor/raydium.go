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

// RaydiumProvider quotes USDC -> tokenOut on Raydium's single-venue Trade API.
// Raydium is NOT an aggregator; the Trade API only routes against Raydium's
// own pools, so many long-tail tokens will legitimately return "no route".
// That's intentional and surfaces the single-venue limitation in the bench.
type RaydiumProvider struct {
	region string
	client *http.Client
}

func NewRaydiumProvider(region string) *RaydiumProvider {
	return &RaydiumProvider{region: region, client: newWarmHTTPClient()}
}

func (p *RaydiumProvider) Slug() string { return "raydium" }

const raydiumQuoteEndpoint = "https://transaction-v1.raydium.io/compute/swap-base-in"

type raydiumQuoteResp struct {
	Success bool   `json:"success"`
	Msg     string `json:"msg"`
	Data    struct {
		OutputAmount string `json:"outputAmount"`
	} `json:"data"`
}

func (p *RaydiumProvider) Probe(ctx context.Context, tokenOut TrendingToken) (int64, bool, error) {
	q := url.Values{}
	q.Set("inputMint", usdcMint)
	q.Set("outputMint", tokenOut.Mint)
	q.Set("amount", canonicalUsdcRaw)
	q.Set("slippageBps", canonicalSlippageBps)
	q.Set("txVersion", "V0")

	fullURL := raydiumQuoteEndpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "request_build")
		return 0, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	start := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		errType := "network"
		if errors.Is(err, context.DeadlineExceeded) {
			errType = "timeout"
		}
		RecordOtherError(p.Slug(), p.region, errType)
		return 0, false, fmt.Errorf("raydium http: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordThrottled(p.Slug(), p.region)
		return 0, false, fmt.Errorf("raydium http 429")
	case http.StatusUnauthorized, http.StatusForbidden:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordAuthError(p.Slug(), p.region)
		return 0, false, fmt.Errorf("raydium http %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "read_body")
		return 0, false, fmt.Errorf("read body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var parsed raydiumQuoteResp
		_ = json.Unmarshal(body, &parsed)
		if isNoRouteSignal("", parsed.Msg) || strings.Contains(strings.ToLower(string(body)), "no route") {
			RecordNoRoute(p.Slug(), p.region)
			return 0, false, fmt.Errorf("raydium no route for %s", tokenOut.Symbol)
		}
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("raydium http %d: %s", resp.StatusCode, parsed.Msg)
	}

	var parsed raydiumQuoteResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		RecordOtherError(p.Slug(), p.region, "parse")
		return 0, false, fmt.Errorf("parse: %w", err)
	}
	if !parsed.Success {
		if isNoRouteSignal("", parsed.Msg) || parsed.Msg == "" {
			// Raydium returns success=false with msg empty or "route not found"
			// when the token isn't in any Raydium pool. Treat all success=false
			// as no-route for the metric (it's an AMM limitation, not a server
			// error).
			RecordNoRoute(p.Slug(), p.region)
			return 0, false, fmt.Errorf("raydium no route for %s: %s", tokenOut.Symbol, parsed.Msg)
		}
		RecordOtherError(p.Slug(), p.region, "api_not_success")
		return 0, false, fmt.Errorf("raydium success=false: %s", parsed.Msg)
	}
	if parsed.Data.OutputAmount == "" {
		RecordNoRoute(p.Slug(), p.region)
		return 0, false, fmt.Errorf("raydium empty data.outputAmount for %s", tokenOut.Symbol)
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}
