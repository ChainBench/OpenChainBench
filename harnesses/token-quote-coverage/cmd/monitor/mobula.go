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
	mobulaUSDCSolana = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	mobulaUSDCBase   = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	mobulaUSDCBSC    = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
	mobulaUSDCEth    = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
)

// MobulaProvider hits api.mobula.io for Solana + EVM chains.
type MobulaProvider struct {
	apiKey string
	client *http.Client
}

func NewMobulaProvider(apiKey string) *MobulaProvider {
	return &MobulaProvider{apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *MobulaProvider) Slug() string { return "mobula" }

func (p *MobulaProvider) SupportsChain(chain string) bool {
	switch chain {
	case "solana", "base", "bsc":
		return true
	}
	return false
}

func (p *MobulaProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var endpoint string

	switch token.Chain {
	case "solana":
		q := url.Values{}
		q.Set("tokenIn", mobulaUSDCSolana)
		q.Set("tokenOut", token.Address)
		q.Set("amount", "1")
		q.Set("blockchain", "solana")
		endpoint = "https://api.mobula.io/api/1/trade/swap/quote?" + q.Encode()
	case "base":
		q := url.Values{}
		q.Set("tokenIn", mobulaUSDCBase)
		q.Set("tokenOut", token.Address)
		q.Set("amount", "1")
		q.Set("chainId", "8453")
		endpoint = "https://api.mobula.io/api/1/trade/swap/quote?" + q.Encode()
	case "bsc":
		q := url.Values{}
		q.Set("tokenIn", mobulaUSDCBSC)
		q.Set("tokenOut", token.Address)
		q.Set("amount", "1")
		q.Set("chainId", "56")
		endpoint = "https://api.mobula.io/api/1/trade/swap/quote?" + q.Encode()
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	req.Header.Set("Authorization", p.apiKey)

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[mobula] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[mobula] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		Data struct {
			AmountOutTokens string `json:"amountOutTokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[mobula] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = r.Data.AmountOutTokens != "" && r.Data.AmountOutTokens != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
