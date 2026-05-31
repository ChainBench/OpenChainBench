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

// MobulaProvider quotes USDC -> tokenOut via Mobula's swap quoting endpoint.
// Auth header is the raw key (no Bearer). Amount is in whole tokens.
type MobulaProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewMobulaProvider(region, apiKey string) *MobulaProvider {
	return &MobulaProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *MobulaProvider) Slug() string { return "mobula" }

const (
	mobulaQuoteEndpoint  = "https://api.mobula.io/api/2/swap/quoting"
	canonicalFromAddress = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH"
)

type mobulaQuoteResp struct {
	Data struct {
		AmountOutTokens string `json:"amountOutTokens"`
	} `json:"data"`
	// Mobula returns 4xx with {message,error,statusCode} on validation errors,
	// and {message:"No route found"} when there's no path for the requested pair.
	Message    string `json:"message"`
	Error      string `json:"error"`
	StatusCode int    `json:"statusCode"`
}

func (p *MobulaProvider) Probe(ctx context.Context, tokenOut TrendingToken) (int64, bool, error) {
	if p.apiKey == "" {
		RecordAuthError(p.Slug(), p.region)
		return 0, false, fmt.Errorf("mobula api key missing")
	}

	q := url.Values{}
	q.Set("chainId", "solana")
	q.Set("tokenIn", usdcMint)
	q.Set("tokenOut", tokenOut.Mint)
	q.Set("amount", canonicalUsdcWhole) // 100 USDC, whole tokens
	q.Set("walletAddress", canonicalFromAddress)
	q.Set("slippage", canonicalSlippagePct)

	fullURL := mobulaQuoteEndpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "request_build")
		return 0, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", p.apiKey)

	start := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		errType := "network"
		if errors.Is(err, context.DeadlineExceeded) {
			errType = "timeout"
		}
		RecordOtherError(p.Slug(), p.region, errType)
		return 0, false, fmt.Errorf("mobula http: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordThrottled(p.Slug(), p.region)
		return 0, false, fmt.Errorf("mobula http 429")
	case http.StatusUnauthorized, http.StatusForbidden:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordAuthError(p.Slug(), p.region)
		return 0, false, fmt.Errorf("mobula http %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "read_body")
		return 0, false, fmt.Errorf("read body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var parsed mobulaQuoteResp
		_ = json.Unmarshal(body, &parsed)
		if isNoRouteSignal(parsed.Error, parsed.Message) ||
			strings.Contains(strings.ToLower(string(body)), "no route") {
			RecordNoRoute(p.Slug(), p.region)
			return 0, false, fmt.Errorf("mobula no route for %s", tokenOut.Symbol)
		}
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("mobula http %d: %s", resp.StatusCode, parsed.Message)
	}

	var parsed mobulaQuoteResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		RecordOtherError(p.Slug(), p.region, "parse")
		return 0, false, fmt.Errorf("parse: %w", err)
	}
	if parsed.Data.AmountOutTokens == "" {
		RecordNoRoute(p.Slug(), p.region)
		return 0, false, fmt.Errorf("mobula empty data.amountOutTokens for %s", tokenOut.Symbol)
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}
