package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// NordsternProvider hits api.nordstern.finance/aggregator/<chainId>.
//
// No key, no registration, and their docs state no fixed rate limits.
// Fourteenth among DEX aggregators by 30d volume, $1.05B, and notable for
// reaching 121 chains. Route benchmarks against it in their own docs
// ("Routing vs Kyber, 0x and Nordstern"), which is a fair sign it belongs
// in the field.
//
// The best-shaped response of the cohort for this work: the output, the
// gas, and the block it simulated at. The simulation block is what makes
// a quote provably contemporaneous with another, and only three providers
// give one.
//
// PARAMETER NAMES: src, dst, amount, recipient. Not tokenIn/tokenOut, and
// recipient is required with a real address or the call 400s. Their docs
// page names the first two differently, so the live API is the authority.
//
// NATIVE ETH: it accepts the canonical 0xEeee sentinel, the zero address
// and WETH, and returns byte-identical results for all three (verified
// 2026-10-19). Wrapping costs gas, not output, so quoting it alongside
// native-input providers compares like with like on the amount.
type NordsternProvider struct {
	region string
	client *http.Client
}

func NewNordsternProvider(region string) *NordsternProvider {
	return &NordsternProvider{region: region, client: newWarmHTTPClient()}
}

func (p *NordsternProvider) Slug() string { return "nordstern" }

func (p *NordsternProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114:
		return true
	}
	return false
}

func (p *NordsternProvider) Probe(ctx context.Context, pair TestPair) (Quote, error) {
	q := url.Values{}
	q.Set("src", pair.TokenIn)
	q.Set("dst", pair.TokenOut)
	q.Set("amount", pair.AmountWei)
	q.Set("recipient", "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416")
	endpoint := fmt.Sprintf("https://api.nordstern.finance/aggregator/%d?%s",
		pair.ChainId, q.Encode())

	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Accept", "application/json")

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return failed(), err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	if resp.StatusCode == 429 {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("429")
	}
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return failed(), fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var r struct {
		ToAmount        string `json:"toAmount"`
		SimulationBlock any    `json:"simulationBlock"`
		Error           string `json:"error"`
		// Nordstern reports units and no price. Its per-swap breakdown
		// carries the same figure under swaps[].gasUnits; the top-level
		// total is the one a trader pays.
		GasEstimate any `json:"gasEstimate"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return failed(), err
	}
	if r.Error != "" {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "api_error")
		return failed(), fmt.Errorf("api_error=%s", snippet([]byte(r.Error)))
	}
	if r.ToAmount == "" || r.ToAmount == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return failed(), fmt.Errorf("no_route")
	}
	quote := okQuote(ms, r.ToAmount)
	quote.GasUnits = uintAny(r.GasEstimate)
	// simulationBlock has come back both as a number and as a string, so
	// take either rather than lose the one field that proves simultaneity.
	switch v := r.SimulationBlock.(type) {
	case float64:
		if v > 0 {
			quote.Block = uint64(v)
		}
	case string:
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			quote.Block = n
		}
	}
	return quote, nil
}
