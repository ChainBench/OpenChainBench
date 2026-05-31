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

// MobulaProvider hits Mobula's swap quote endpoint for the canonical 1 SOL ->
// USDC swap. Differences from Jupiter:
//   - Auth via `Authorization: <MOBULA_API_KEY>` header — NO Bearer prefix.
//   - Query params: chainId=solana, tokenIn, tokenOut, walletAddress, slippage (percent).
//   - `amount` is in WHOLE TOKENS (1 = 1 SOL) — Mobula also accepts `amountRaw`
//     for raw lamports, but `amount=1` is the simpler form here.
//   - Response field: data.amountOutTokens (human-readable, decimal string).
type MobulaProvider struct {
	region string
	apiKey string
}

func NewMobulaProvider(region, apiKey string) *MobulaProvider {
	return &MobulaProvider{region: region, apiKey: apiKey}
}

func (p *MobulaProvider) Slug() string { return "mobula" }

const (
	mobulaQuoteEndpoint  = "https://api.mobula.io/api/2/swap/quoting"
	canonicalSlippagePct = "0.5"
	canonicalFromAddress = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH"
)

type mobulaQuoteResp struct {
	Data struct {
		AmountOutTokens string `json:"amountOutTokens"`
	} `json:"data"`
}

func (p *MobulaProvider) Probe(ctx context.Context) (int64, bool, error) {
	if p.apiKey == "" {
		RecordAuthError(p.Slug(), p.region)
		return 0, false, fmt.Errorf("mobula api key missing")
	}

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
	q.Set("chainId", "solana")
	q.Set("tokenIn", solMint)
	q.Set("tokenOut", usdcMint)
	// Whole tokens — 1 = 1 SOL. Mobula treats `amount` as human-readable units.
	q.Set("amount", "1")
	q.Set("walletAddress", canonicalFromAddress)
	q.Set("slippage", canonicalSlippagePct)

	fullURL := mobulaQuoteEndpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "request_build")
		return 0, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	// Mobula expects the raw key in Authorization (no Bearer prefix).
	req.Header.Set("Authorization", p.apiKey)

	start := time.Now()
	resp, err := client.Do(req)
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
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("mobula http %d", resp.StatusCode)
	}

	var parsed mobulaQuoteResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		RecordOtherError(p.Slug(), p.region, "parse")
		return 0, false, fmt.Errorf("parse: %w", err)
	}
	if parsed.Data.AmountOutTokens == "" {
		RecordOtherError(p.Slug(), p.region, "empty_quote")
		return 0, false, fmt.Errorf("empty data.amountOutTokens")
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}
