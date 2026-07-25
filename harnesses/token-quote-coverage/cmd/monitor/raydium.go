package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

const raydiumUSDCSolana = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

type RaydiumProvider struct {
	client *http.Client
}

func NewRaydiumProvider() *RaydiumProvider {
	return &RaydiumProvider{client: newWarmHTTPClient()}
}

func (p *RaydiumProvider) Slug() string { return "raydium" }

func (p *RaydiumProvider) SupportsChain(chain string) bool {
	return chain == "solana"
}

func (p *RaydiumProvider) Quote(ctx context.Context, token Token) (ok bool) {
	if token.Chain != "solana" {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	q := url.Values{}
	q.Set("inputMint", raydiumUSDCSolana)
	q.Set("outputMint", token.Address)
	q.Set("amount", "1000000")
	q.Set("slippageBps", "500")
	q.Set("txVersion", "V0")
	endpoint := "https://api-v3.raydium.io/compute/swap-base-in?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[raydium] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[raydium] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		Success bool `json:"success"`
		Data    struct {
			OutputAmount string `json:"outputAmount"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[raydium] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = r.Success && r.Data.OutputAmount != "" && r.Data.OutputAmount != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
