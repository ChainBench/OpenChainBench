package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type defillamaClient struct {
	http *http.Client
}

func newDefillamaClient() *defillamaClient {
	return &defillamaClient{http: &http.Client{Timeout: 15 * time.Second}}
}

// fetchFomoFees returns Fomo's 24h Solana fees in USD from DeFiLlama.
// Fomo combines on-chain USDC inflows + off-chain relay fees via a private
// Dune table (dune.tryfomo.fomo_relay_fees) that only DeFiLlama can read.
func (c *defillamaClient) fetchFomoFees() (float64, error) {
	req, err := http.NewRequest(http.MethodGet, "https://api.llama.fi/summary/fees/fomo", nil)
	if err != nil {
		return 0, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, err
	}
	if resp.StatusCode >= 400 {
		return 0, fmt.Errorf("status %d", resp.StatusCode)
	}
	var out struct {
		ChainBreakdown map[string]struct {
			Total24h float64 `json:"total24h"`
		} `json:"chainBreakdown"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if bd, ok := out.ChainBreakdown["Solana"]; ok {
		return bd.Total24h, nil
	}
	return 0, nil
}
