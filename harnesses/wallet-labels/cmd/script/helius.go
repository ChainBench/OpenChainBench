package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type HeliusProvider struct{ apiKey string }

func NewHeliusProvider(key string) *HeliusProvider { return &HeliusProvider{apiKey: key} }

func (p *HeliusProvider) Name() string { return "helius" }

// Helius Wallet Identity is Solana-only.
func (p *HeliusProvider) Supports(chain string) bool { return chain == "solana" }

func (p *HeliusProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if !p.Supports(chain) || p.apiKey == "" {
		return res
	}
	start := time.Now()
	u := "https://api.helius.xyz/v1/wallet/" + address + "/identity?api-key=" + p.apiKey
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	resp, err := httpClient.Do(req)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Err = err
		return res
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		res.Err = fmt.Errorf("status_%d", resp.StatusCode)
		return res
	}
	var body struct {
		Address  string   `json:"address"`
		Type     string   `json:"type"`
		Name     string   `json:"name"`
		Category string   `json:"category"`
		Tags     []string `json:"tags"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if !genericLabel(body.Name) {
		res.Label = body.Name
		res.HasLabel = true
		res.Raw = map[string]any{"name": body.Name, "type": body.Type, "category": body.Category}
	}
	return res
}
