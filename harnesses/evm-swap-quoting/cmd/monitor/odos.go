package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OdosProvider hits api.odos.xyz/sor/quote/v2.
// Anonymous: aggressively rate-limited (~3 calls/IP/bucket). With free key
// from app.odos.xyz the bucket is much wider — that's why we gate on key.
// NATIVE-ETH SENTINEL: 0x0000...0000 (NOT the canonical 0xEeee...).
type OdosProvider struct {
	region string
	apiKey string
	client *http.Client
}

func NewOdosProvider(region, apiKey string) *OdosProvider {
	return &OdosProvider{region: region, apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *OdosProvider) Slug() string { return "odos" }

func (p *OdosProvider) Supports(chainId int) bool {
	switch chainId {
	case 1, 10, 56, 137, 8453, 42161, 43114, 5000, 324, 534352, 81457, 250, 59144, 130:
		return true
	}
	return false
}

func (p *OdosProvider) Probe(ctx context.Context, pair TestPair) (int64, bool, error) {
	tokenIn := pair.TokenIn
	tokenOut := pair.TokenOut
	if strings.EqualFold(tokenIn, NativeSentinel) {
		tokenIn = ZeroAddress
	}
	if strings.EqualFold(tokenOut, NativeSentinel) {
		tokenOut = ZeroAddress
	}

	body := map[string]any{
		"chainId": pair.ChainId,
		"inputTokens": []map[string]any{
			{"tokenAddress": tokenIn, "amount": pair.AmountWei},
		},
		"outputTokens": []map[string]any{
			{"tokenAddress": tokenOut, "proportion": 1},
		},
		"slippageLimitPercent": 1,
		"userAddr":             "0xbb663a119193cA68512c351b0fdfDEB9c22Dc416",
	}
	bb, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.odos.xyz/sor/quote/v2", bytes.NewBuffer(bb))
	req.Header.Set("Content-Type", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}

	t0 := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, classifyNetErr(err))
		return 0, false, err
	}
	defer resp.Body.Close()
	ms := time.Since(t0).Milliseconds()

	if resp.StatusCode == 429 {
		RecordThrottled(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("429")
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		RecordAuthError(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("%d", resp.StatusCode)
	}
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		RecordOtherError(p.Slug(), pair.Chain, p.region, fmt.Sprintf("http_%d", resp.StatusCode))
		return 0, false, fmt.Errorf("status=%d body=%s", resp.StatusCode, snippet(rb))
	}
	var r struct {
		OutAmounts []string `json:"outAmounts"`
	}
	if err := json.Unmarshal(rb, &r); err != nil {
		RecordOtherError(p.Slug(), pair.Chain, p.region, "parse")
		return 0, false, err
	}
	if len(r.OutAmounts) == 0 || r.OutAmounts[0] == "" || r.OutAmounts[0] == "0" {
		RecordNoRoute(p.Slug(), pair.Chain, p.region)
		return 0, false, fmt.Errorf("no_route")
	}
	return ms, true, nil
}
