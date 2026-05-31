package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// RaydiumProvider hits Raydium's single-venue Trade API for the canonical
// 1 SOL -> USDC swap. Note: Raydium is NOT an aggregator — its Trade API
// routes only against Raydium's own pools. Included as a reference for
// what a direct AMM compute endpoint costs vs. an aggregator search.
//
// Response shape diverges from Jupiter:
//   - Wrapper: {id, success: bool, version, data: {...}}
//   - Quote field: data.outputAmount (NOT data.outAmount).
//   - Must verify success == true before reading data.
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
	Success bool `json:"success"`
	Data    struct {
		OutputAmount string `json:"outputAmount"`
	} `json:"data"`
}

func (p *RaydiumProvider) Probe(ctx context.Context) (int64, bool, error) {
	q := url.Values{}
	q.Set("inputMint", solMint)
	q.Set("outputMint", usdcMint)
	q.Set("amount", canonicalAmountSol)
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
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("raydium http %d", resp.StatusCode)
	}

	var parsed raydiumQuoteResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		RecordOtherError(p.Slug(), p.region, "parse")
		return 0, false, fmt.Errorf("parse: %w", err)
	}
	if !parsed.Success {
		RecordOtherError(p.Slug(), p.region, "api_not_success")
		return 0, false, fmt.Errorf("raydium success=false")
	}
	if parsed.Data.OutputAmount == "" {
		RecordOtherError(p.Slug(), p.region, "empty_quote")
		return 0, false, fmt.Errorf("empty data.outputAmount")
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}
