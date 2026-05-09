package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type MoralisProvider struct{ apiKey string }

func NewMoralisProvider(key string) *MoralisProvider { return &MoralisProvider{apiKey: key} }

func (p *MoralisProvider) Name() string { return "moralis" }

// Moralis Web3 Data API is EVM-only (no Solana wallet labels endpoint).
func (p *MoralisProvider) Supports(chain string) bool {
	return moralisChainSlug(chain) != ""
}

// moralisChainSlug maps our internal chain id to Moralis' `chain` query param.
func moralisChainSlug(chain string) string {
	switch chain {
	case "ethereum":
		return "eth"
	case "base":
		return "base"
	case "bnb":
		return "bsc"
	case "polygon":
		return "polygon"
	case "arbitrum":
		return "arbitrum"
	case "optimism":
		return "optimism"
	case "avalanche":
		return "avalanche"
	}
	return ""
}

// Moralis labels live in the /entities transaction enrichment, not a direct
// per-address lookup. We fetch the most recent tx for the address and pull
// the entity off the matching side.
func (p *MoralisProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	slug := moralisChainSlug(chain)
	if slug == "" || p.apiKey == "" {
		return res
	}
	start := time.Now()
	u := "https://deep-index.moralis.io/api/v2.2/entities?chain=" + slug + "&address=" + address + "&limit=1"
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("X-API-Key", p.apiKey)
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
		Result []struct {
			FromAddress       string `json:"from_address"`
			FromAddressEntity string `json:"from_address_entity"`
			FromAddressLabel  string `json:"from_address_label"`
			ToAddress         string `json:"to_address"`
			ToAddressEntity   string `json:"to_address_entity"`
			ToAddressLabel    string `json:"to_address_label"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if len(body.Result) == 0 {
		return res
	}
	r := body.Result[0]
	addrLow := strings.ToLower(address)
	var entity, label string
	if strings.ToLower(r.FromAddress) == addrLow {
		entity, label = r.FromAddressEntity, r.FromAddressLabel
	} else if strings.ToLower(r.ToAddress) == addrLow {
		entity, label = r.ToAddressEntity, r.ToAddressLabel
	}
	if !genericLabel(entity) {
		res.Label = entity
		res.HasLabel = true
		res.Raw = map[string]any{"entity": entity, "label": label}
	}
	return res
}
