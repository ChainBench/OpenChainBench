package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const (
	odosUSDCBase      = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	odosUSDCBSC       = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
	odosUSDGRobinhood = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
)

// OdosProvider hits api.odos.xyz/sor/quote/v2 for Base and BSC.
type OdosProvider struct {
	client *http.Client
}

func NewOdosProvider() *OdosProvider {
	return &OdosProvider{client: newWarmHTTPClient()}
}

func (p *OdosProvider) Slug() string { return "odos" }

func (p *OdosProvider) SupportsChain(chain string) bool {
	return chain == "base" || chain == "bsc" || chain == "robinhood"
}

func (p *OdosProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var chainId int
	var usdcAddr string
	switch token.Chain {
	case "base":
		chainId = 8453
		usdcAddr = odosUSDCBase
	case "bsc":
		chainId = 56
		usdcAddr = odosUSDCBSC
	case "robinhood":
		chainId = 4663
		usdcAddr = odosUSDGRobinhood
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	payload := map[string]any{
		"chainId": chainId,
		"inputTokens": []map[string]any{
			{"tokenAddress": usdcAddr, "amount": "1000000"},
		},
		"outputTokens": []map[string]any{
			{"tokenAddress": token.Address, "proportion": 1},
		},
		"slippageLimitPercent": 5,
		"userAddr":             "0x0000000000000000000000000000000000000001",
	}
	bb, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.odos.xyz/sor/quote/v2", bytes.NewBuffer(bb))
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[odos] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 429 {
		fmt.Printf("[odos] %s/%s throttled\n", token.Chain, token.Address)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	if resp.StatusCode != 200 {
		fmt.Printf("[odos] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		OutAmounts []string `json:"outAmounts"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[odos] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = len(r.OutAmounts) > 0 && r.OutAmounts[0] != "" && r.OutAmounts[0] != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
