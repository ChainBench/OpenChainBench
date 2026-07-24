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
	oneinchUSDCBase = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	oneinchUSDCBSC  = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
)

// OneInchProvider hits api.1inch.dev for Base and BSC.
type OneInchProvider struct {
	apiKey string
	client *http.Client
}

func NewOneInchProvider(apiKey string) *OneInchProvider {
	return &OneInchProvider{apiKey: apiKey, client: newWarmHTTPClient()}
}

func (p *OneInchProvider) Slug() string { return "1inch" }

func (p *OneInchProvider) SupportsChain(chain string) bool {
	return chain == "base" || chain == "bsc"
}

func (p *OneInchProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var chainId int
	var usdcAddr string
	switch token.Chain {
	case "base":
		chainId = 8453
		usdcAddr = oneinchUSDCBase
	case "bsc":
		chainId = 56
		usdcAddr = oneinchUSDCBSC
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	q := url.Values{}
	q.Set("src", usdcAddr)
	q.Set("dst", token.Address)
	q.Set("amount", "1000000")
	endpoint := fmt.Sprintf("https://api.1inch.dev/swap/v6.0/%d/quote?%s", chainId, q.Encode())

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[1inch] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 429 {
		fmt.Printf("[1inch] %s/%s throttled\n", token.Chain, token.Address)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		fmt.Printf("[1inch] auth error %d\n", resp.StatusCode)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	if resp.StatusCode != 200 {
		fmt.Printf("[1inch] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		ToAmount string `json:"toAmount"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[1inch] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = r.ToAmount != "" && r.ToAmount != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
