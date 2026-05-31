package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// JupiterProvider hits the public Jupiter Lite quote endpoint for a canonical
// SOL -> USDC swap of 1 SOL with 50bps slippage.
type JupiterProvider struct {
	region string
	apiKey string // optional; lite endpoint works without it
}

func NewJupiterProvider(region, apiKey string) *JupiterProvider {
	return &JupiterProvider{region: region, apiKey: apiKey}
}

func (p *JupiterProvider) Slug() string { return "jupiter" }

const (
	jupiterQuoteEndpoint = "https://lite-api.jup.ag/swap/v1/quote"
	solMint              = "So11111111111111111111111111111111111111112"
	usdcMint             = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	canonicalAmountSol   = "1000000000" // 1 SOL in lamports
	canonicalSlippageBps = "50"
)

type jupiterQuoteResp struct {
	OutAmount string `json:"outAmount"`
}

func (p *JupiterProvider) Probe(ctx context.Context) (int64, bool, error) {
	// Fresh TCP/TLS per tick. We want DNS+dial+TLS overhead in the measurement.
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: -1,
			}).DialContext,
			DisableKeepAlives:     true,
			MaxIdleConns:          0,
			IdleConnTimeout:       0,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}

	q := url.Values{}
	q.Set("inputMint", solMint)
	q.Set("outputMint", usdcMint)
	q.Set("amount", canonicalAmountSol)
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
	resp, err := client.Do(req)
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
		RecordOtherError(p.Slug(), p.region, "empty_quote")
		return 0, false, fmt.Errorf("empty outAmount")
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}
