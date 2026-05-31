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

// OpenOceanProvider hits the public OpenOcean v4 Solana quote endpoint for the
// canonical 1 SOL -> USDC swap. OpenOcean differs from Jupiter in two ways:
//   - `amount` is in whole tokens (1 = 1 SOL), NOT lamports.
//   - The body is double-enveloped: {code, data:{code, ..., outAmount}}.
type OpenOceanProvider struct {
	region string
}

func NewOpenOceanProvider(region string) *OpenOceanProvider {
	return &OpenOceanProvider{region: region}
}

func (p *OpenOceanProvider) Slug() string { return "openocean" }

const openOceanQuoteEndpoint = "https://open-api.openocean.finance/v4/solana/quote"

type openOceanQuoteResp struct {
	Code int `json:"code"`
	Data struct {
		Code      int    `json:"code"`
		OutAmount string `json:"outAmount"`
	} `json:"data"`
}

func (p *OpenOceanProvider) Probe(ctx context.Context) (int64, bool, error) {
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
	q.Set("inTokenAddress", solMint)
	q.Set("outTokenAddress", usdcMint)
	// Whole token, not lamports. Canonical 1 SOL.
	q.Set("amount", "1")
	q.Set("gasPrice", "0.000005")
	// Percent, not bps. 0.5% = 50 bps.
	q.Set("slippage", "0.5")

	fullURL := openOceanQuoteEndpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "request_build")
		return 0, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		errType := "network"
		if errors.Is(err, context.DeadlineExceeded) {
			errType = "timeout"
		}
		RecordOtherError(p.Slug(), p.region, errType)
		return 0, false, fmt.Errorf("openocean http: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordThrottled(p.Slug(), p.region)
		return 0, false, fmt.Errorf("openocean http 429")
	case http.StatusUnauthorized, http.StatusForbidden:
		_, _ = io.Copy(io.Discard, resp.Body)
		RecordAuthError(p.Slug(), p.region)
		return 0, false, fmt.Errorf("openocean http %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		RecordOtherError(p.Slug(), p.region, "read_body")
		return 0, false, fmt.Errorf("read body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("openocean http %d", resp.StatusCode)
	}

	var parsed openOceanQuoteResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		RecordOtherError(p.Slug(), p.region, "parse")
		return 0, false, fmt.Errorf("parse: %w", err)
	}
	if parsed.Code != 200 || parsed.Data.Code != 0 {
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("api_code_%d_%d", parsed.Code, parsed.Data.Code))
		return 0, false, fmt.Errorf("openocean api code %d/%d", parsed.Code, parsed.Data.Code)
	}
	if parsed.Data.OutAmount == "" {
		RecordOtherError(p.Slug(), p.region, "empty_quote")
		return 0, false, fmt.Errorf("empty data.outAmount")
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}
