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
	mobulaUSDCBase      = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	mobulaUSDCBSC       = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
	mobulaUSDGRobinhood = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
	mobulaUSDCSolana    = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	// dummy EVM wallet (no funds needed for quote)
	mobulaWallet = "0x0000000000000000000000000000000000000001"
	// dummy Solana wallet — Mobula routes the swap but tx build fails due to
	// missing SOL for fees; we treat "Transaction build failed" as a coverage
	// HIT since the route itself was found.
	mobulaSolanaWallet = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ"
)

// MobulaProvider hits api.mobula.io/api/2/swap/quoting for EVM chains and Solana.
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
	case "base", "bsc", "robinhood", "solana":
		return true
	}
	return false
}

func (p *MobulaProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var chainId, tokenIn, wallet string
	switch token.Chain {
	case "base":
		chainId, tokenIn, wallet = "8453", mobulaUSDCBase, mobulaWallet
	case "bsc":
		chainId, tokenIn, wallet = "56", mobulaUSDCBSC, mobulaWallet
	case "robinhood":
		chainId, tokenIn, wallet = "4663", mobulaUSDGRobinhood, mobulaWallet
	case "solana":
		chainId, tokenIn, wallet = "solana", mobulaUSDCSolana, mobulaSolanaWallet
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	amount := "1"
	if token.Chain == "solana" {
		amount = "1000000"
	}
	q := url.Values{}
	q.Set("tokenIn", tokenIn)
	q.Set("tokenOut", token.Address)
	q.Set("amount", amount)
	q.Set("chainId", chainId)
	q.Set("walletAddress", wallet)
	endpoint := "https://api.mobula.io/api/2/swap/quoting?" + q.Encode()

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
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[mobula] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	// For Solana: Mobula finds the route but fails to build the tx because the
	// dummy wallet has no SOL for fees. Route found = coverage HIT.
	if token.Chain == "solana" && r.Error == "Transaction build failed" {
		RecordProbe(p.Slug(), token.Venue, token.Chain, true)
		return true
	}

	ok = r.Data.AmountOutTokens != "" && r.Data.AmountOutTokens != "0"
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
