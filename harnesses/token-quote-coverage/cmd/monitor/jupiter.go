package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

const (
	jupiterUSDCMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
)

// JupiterProvider hits quote-api.jup.ag/v6/quote for Solana tokens.
type JupiterProvider struct {
	client *http.Client
}

func NewJupiterProvider() *JupiterProvider {
	return &JupiterProvider{client: newWarmHTTPClient()}
}

func (p *JupiterProvider) Slug() string { return "jupiter" }

func (p *JupiterProvider) SupportsChain(chain string) bool {
	return chain == "solana"
}

func (p *JupiterProvider) Quote(ctx context.Context, token Token) (ok bool) {
	q := url.Values{}
	q.Set("inputMint", jupiterUSDCMint)
	q.Set("outputMint", token.Address)
	q.Set("amount", "1000000")
	q.Set("slippageBps", "5000")
	q.Set("strictMode", "false")
	endpoint := "https://quote-api.jup.ag/v6/quote?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[jupiter] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[jupiter] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		OutAmount string `json:"outAmount"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[jupiter] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	n, _ := strconv.ParseInt(r.OutAmount, 10, 64)
	ok = n > 0
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
