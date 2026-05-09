package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type TonAPIProvider struct{}

func NewTonAPIProvider() *TonAPIProvider { return &TonAPIProvider{} }

func (p *TonAPIProvider) Name() string                { return "tonapi" }
func (p *TonAPIProvider) Supports(chain string) bool  { return chain == "ton" }

func (p *TonAPIProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if !p.Supports(chain) {
		return res
	}
	start := time.Now()
	u := "https://tonapi.io/v2/accounts/" + address
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
		Name   string `json:"name"`
		IsScam bool   `json:"is_scam"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if !genericLabel(body.Name) {
		res.Label = body.Name
		res.HasLabel = true
		res.Raw = map[string]any{"name": body.Name, "is_scam": body.IsScam}
	}
	return res
}
