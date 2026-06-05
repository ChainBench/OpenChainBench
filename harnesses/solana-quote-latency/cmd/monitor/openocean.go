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

// OpenOceanProvider quotes USDC -> tokenOut on OpenOcean's v4 Solana quote
// endpoint. Amount is in whole tokens. Body is double-enveloped:
// {code, data:{code, ..., outAmount}}.
type OpenOceanProvider struct {
	region string
	client *http.Client
}

func NewOpenOceanProvider(region string) *OpenOceanProvider {
	return &OpenOceanProvider{region: region, client: newWarmHTTPClient()}
}

func (p *OpenOceanProvider) Slug() string { return "openocean" }

const openOceanQuoteEndpoint = "https://open-api.openocean.finance/v4/solana/quote"

type openOceanQuoteResp struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Code        int     `json:"code"`
		Message     string  `json:"message"`
		OutAmount   string  `json:"outAmount"`
		DexId       int     `json:"dexId"`
		Path        any     `json:"path"`        // null when no route
		PriceImpact string  `json:"price_impact"` // "-100%" when no route
	} `json:"data"`
}

// openOceanIsNoRouteBody returns true when OpenOcean's success-looking response
// is in fact a "no route" — OpenOcean does NOT return a string error for this,
// you have to read the payload (verified via deep-test):
//   - outAmount == "0"
//   - dexId < 0  (negative dexId signals route-engine gave up)
//   - path is null
//   - price_impact == "-100%"
// Any of these is sufficient.
func openOceanIsNoRouteBody(p *openOceanQuoteResp) bool {
	if p.Data.OutAmount == "0" || p.Data.OutAmount == "" {
		return true
	}
	if p.Data.DexId < 0 {
		return true
	}
	if p.Data.Path == nil {
		return true
	}
	if p.Data.PriceImpact == "-100%" {
		return true
	}
	return false
}

func (p *OpenOceanProvider) Probe(ctx context.Context, tokenOut TrendingToken) (int64, bool, error) {
	q := url.Values{}
	q.Set("inTokenAddress", usdcMint)
	q.Set("outTokenAddress", tokenOut.Mint)
	q.Set("amount", canonicalUsdcWhole)
	q.Set("gasPrice", "0.000005")
	q.Set("slippage", canonicalSlippagePct)

	fullURL := openOceanQuoteEndpoint + "?" + q.Encode()
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
		var parsed openOceanQuoteResp
		_ = json.Unmarshal(body, &parsed)
		if isNoRouteSignal("", parsed.Message) || isNoRouteSignal("", parsed.Data.Message) ||
			strings.Contains(strings.ToLower(string(body)), "no route") {
			RecordNoRoute(p.Slug(), p.region)
			return 0, false, fmt.Errorf("openocean no route for %s", tokenOut.Symbol)
		}
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("openocean http %d", resp.StatusCode)
	}

	var parsed openOceanQuoteResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		RecordOtherError(p.Slug(), p.region, "parse")
		return 0, false, fmt.Errorf("parse: %w", err)
	}
	// OpenOcean returns HTTP 200 + wrapper code:200 + data.code:0 even on
	// no-route. The signal is in the data payload (outAmount=="0", dexId<0,
	// path==null, price_impact=="-100%"). Check that BEFORE we trust the
	// envelope as "success".
	if openOceanIsNoRouteBody(&parsed) {
		RecordNoRoute(p.Slug(), p.region)
		return 0, false, fmt.Errorf("openocean no route for %s (outAmount=%q dexId=%d)", tokenOut.Symbol, parsed.Data.OutAmount, parsed.Data.DexId)
	}
	if parsed.Code != 200 || parsed.Data.Code != 0 {
		if isNoRouteSignal("", parsed.Message) || isNoRouteSignal("", parsed.Data.Message) {
			RecordNoRoute(p.Slug(), p.region)
			return 0, false, fmt.Errorf("openocean no route for %s (code=%d/%d)", tokenOut.Symbol, parsed.Code, parsed.Data.Code)
		}
		RecordOtherError(p.Slug(), p.region, fmt.Sprintf("api_code_%d_%d", parsed.Code, parsed.Data.Code))
		return 0, false, fmt.Errorf("openocean api code %d/%d: %s", parsed.Code, parsed.Data.Code, parsed.Message)
	}

	latencyMs := time.Since(start).Milliseconds()
	return latencyMs, true, nil
}
