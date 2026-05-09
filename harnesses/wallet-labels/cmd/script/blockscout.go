package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type BlockscoutProvider struct{}

func NewBlockscoutProvider() *BlockscoutProvider { return &BlockscoutProvider{} }

func (p *BlockscoutProvider) Name() string { return "blockscout" }

// Blockscout instances exist for many EVM chains. We map our chain id to
// the canonical instance host. Unlisted chains return false.
func (p *BlockscoutProvider) Supports(chain string) bool {
	return blockscoutHost(chain) != ""
}

func blockscoutHost(chain string) string {
	switch chain {
	case "ethereum":
		return "eth.blockscout.com"
	case "base":
		return "base.blockscout.com"
	case "optimism":
		return "optimism.blockscout.com"
	case "polygon":
		return "polygon.blockscout.com"
	case "gnosis":
		return "gnosis.blockscout.com"
	}
	return ""
}

func (p *BlockscoutProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	host := blockscoutHost(chain)
	if host == "" {
		return res
	}
	start := time.Now()
	u := "https://" + host + "/api/v2/addresses/" + address
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
		Name       string `json:"name"`
		PublicTags []struct {
			DisplayName string `json:"display_name"`
			Label       string `json:"label"`
		} `json:"public_tags"`
		WatchlistNames []struct {
			DisplayName string `json:"display_name"`
			Label       string `json:"label"`
		} `json:"watchlist_names"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	// Prefer name, then first public_tag, then first watchlist_name.
	pick := body.Name
	if pick == "" && len(body.PublicTags) > 0 {
		pick = body.PublicTags[0].DisplayName
	}
	if pick == "" && len(body.WatchlistNames) > 0 {
		pick = body.WatchlistNames[0].DisplayName
	}
	if !genericLabel(pick) {
		res.Label = pick
		res.HasLabel = true
		res.Raw = map[string]any{"name": pick}
	}
	return res
}
