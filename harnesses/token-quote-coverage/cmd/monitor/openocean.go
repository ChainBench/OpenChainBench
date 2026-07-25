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
	openoceanUSDCBase   = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	openoceanUSDCBSC    = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
	openoceanUSDCSolana = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
)

type OpenOceanProvider struct {
	client *http.Client
}

func NewOpenOceanProvider() *OpenOceanProvider {
	return &OpenOceanProvider{client: newWarmHTTPClient()}
}

func (p *OpenOceanProvider) Slug() string { return "openocean" }

func (p *OpenOceanProvider) SupportsChain(chain string) bool {
	return chain == "base" || chain == "bsc" || chain == "solana"
}

func (p *OpenOceanProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var chainSlug, usdcAddr string
	switch token.Chain {
	case "base":
		chainSlug = "base"
		usdcAddr = openoceanUSDCBase
	case "bsc":
		chainSlug = "bsc"
		usdcAddr = openoceanUSDCBSC
	case "solana":
		chainSlug = "sol"
		usdcAddr = openoceanUSDCSolana
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	q := url.Values{}
	q.Set("inTokenAddress", usdcAddr)
	q.Set("outTokenAddress", token.Address)
	q.Set("amount", "1")
	q.Set("gasPrice", "5")
	q.Set("slippage", "50")
	endpoint := fmt.Sprintf("https://open-api.openocean.finance/v3/%s/swap_quote?%s", chainSlug, q.Encode())

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[openocean] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		fmt.Printf("[openocean] %s/%s status=%d body=%s\n", token.Chain, token.Address, resp.StatusCode, snippet(body))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	var r struct {
		Code int `json:"code"`
		Data struct {
			OutAmount string `json:"outAmount"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[openocean] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = r.Code == 200 && r.Data.OutAmount != "" && r.Data.OutAmount != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
