package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

const (
	okxUSDCSolana = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	okxUSDCBase   = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	okxUSDCBSC    = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
)

// OKXDEXProvider hits the OKX DEX aggregator quote API.
// OKX_DEX_API_KEY is optional — anonymous requests are allowed but may be rate-limited.
type OKXDEXProvider struct {
	apiKey string
	client *http.Client
}

func NewOKXDEXProvider(apiKey string) *OKXDEXProvider {
	return &OKXDEXProvider{apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *OKXDEXProvider) Slug() string { return "okx-dex" }

func (p *OKXDEXProvider) SupportsChain(chain string) bool {
	switch chain {
	case "solana", "base", "bsc":
		return true
	}
	return false
}

func (p *OKXDEXProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var chainId, usdcAddr string
	switch token.Chain {
	case "solana":
		chainId = "501"
		usdcAddr = okxUSDCSolana
	case "base":
		chainId = "8453"
		usdcAddr = okxUSDCBase
	case "bsc":
		chainId = "56"
		usdcAddr = okxUSDCBSC
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	q := url.Values{}
	q.Set("chainId", chainId)
	q.Set("fromTokenAddress", usdcAddr)
	q.Set("toTokenAddress", token.Address)
	q.Set("amount", "1000000")
	endpoint := "https://www.okx.com/api/v5/dex/aggregator/quote?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	if p.apiKey != "" {
		req.Header.Set("OK-ACCESS-KEY", p.apiKey)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[okx-dex] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[okx-dex] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		Data []struct {
			ToTokenAmount string `json:"toTokenAmount"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[okx-dex] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = len(r.Data) > 0 && r.Data[0].ToTokenAmount != "" && r.Data[0].ToTokenAmount != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
