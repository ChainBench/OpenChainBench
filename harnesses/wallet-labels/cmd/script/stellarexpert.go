package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type StellarExpertProvider struct{}

func NewStellarExpertProvider() *StellarExpertProvider { return &StellarExpertProvider{} }

func (p *StellarExpertProvider) Name() string                { return "stellarexpert" }
func (p *StellarExpertProvider) Supports(chain string) bool  { return chain == "stellar" }

func (p *StellarExpertProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if !p.Supports(chain) {
		return res
	}
	start := time.Now()
	u := "https://api.stellar.expert/explorer/directory/" + address
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	resp, err := httpClient.Do(req)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Err = err
		return res
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		// directory miss is expected for fresh wallets — not an error.
		return res
	}
	if resp.StatusCode != 200 {
		res.Err = fmt.Errorf("status_%d", resp.StatusCode)
		return res
	}
	var body struct {
		Name   string   `json:"name"`
		Domain string   `json:"domain"`
		Tags   []string `json:"tags"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if !genericLabel(body.Name) {
		res.Label = body.Name
		res.HasLabel = true
		res.Raw = map[string]any{"name": body.Name, "domain": body.Domain, "tags": body.Tags}
	}
	return res
}
