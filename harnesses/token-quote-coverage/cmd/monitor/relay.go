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
	relayUSDCSolana    = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	relayUSDCBase      = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	relayUSDCBSC       = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
	relayUSDGRobinhood = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
	relaySolanaUser    = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ"
	relayEVMUser       = "0x0000000000000000000000000000000000000001"
)

type RelayProvider struct {
	client *http.Client
}

func NewRelayProvider() *RelayProvider {
	return &RelayProvider{client: newWarmHTTPClient()}
}

func (p *RelayProvider) Slug() string { return "relay" }

func (p *RelayProvider) SupportsChain(chain string) bool {
	switch chain {
	case "solana", "base", "bsc", "robinhood":
		return true
	}
	return false
}

func (p *RelayProvider) Quote(ctx context.Context, token Token) (ok bool) {
	var chainId int
	var tokenIn, user string
	switch token.Chain {
	case "solana":
		chainId, tokenIn, user = 792703809, relayUSDCSolana, relaySolanaUser
	case "base":
		chainId, tokenIn, user = 8453, relayUSDCBase, relayEVMUser
	case "bsc":
		chainId, tokenIn, user = 56, relayUSDCBSC, relayEVMUser
	case "robinhood":
		chainId, tokenIn, user = 4663, relayUSDGRobinhood, relayEVMUser
	default:
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	payload, _ := json.Marshal(map[string]interface{}{
		"user":                user,
		"originChainId":       chainId,
		"destinationChainId":  chainId,
		"originCurrency":      tokenIn,
		"destinationCurrency": token.Address,
		"amount":              "1000000",
		"tradeType":           "EXACT_INPUT",
	})

	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.relay.link/quote", bytes.NewReader(payload))
	if err != nil {
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		fmt.Printf("[relay] %s/%s net error: %s\n", token.Chain, token.Address, classifyNetErr(err))
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	var r struct {
		Details struct {
			CurrencyOut struct {
				Amount string `json:"amount"`
			} `json:"currencyOut"`
		} `json:"details"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		fmt.Printf("[relay] %s/%s parse error: %v\n", token.Chain, token.Address, err)
		RecordProbe(p.Slug(), token.Venue, token.Chain, false)
		return false
	}

	ok = r.Details.CurrencyOut.Amount != "" && r.Details.CurrencyOut.Amount != "0"
	if !ok && r.Message != "" {
		fmt.Printf("[relay] %s/%s: %s\n", token.Chain, token.Address, r.Message)
	}
	RecordProbe(p.Slug(), token.Venue, token.Chain, ok)
	return ok
}
