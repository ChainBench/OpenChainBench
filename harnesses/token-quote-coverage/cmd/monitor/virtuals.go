package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// FetchVirtualsTokens returns recently graduated Virtuals Protocol agents on Base.
// SENTIENT status = agents that have a live DEX pool (real tokenAddress set).
// Sorted by lpCreatedAt desc so freshest graduates come first.
func FetchVirtualsTokens(ctx context.Context) ([]boostEntry, error) {
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://api.virtuals.io/api/virtuals?filters[status]=SENTIENT&sort[0]=lpCreatedAt:desc&pagination[pageSize]=20",
		nil)
	if err != nil {
		return nil, err
	}

	resp, err := dexClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("virtuals: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("virtuals: status=%d body=%s", resp.StatusCode, snippet(body))
	}

	// The API returns either {"data": [items]} or {"data": {"data": [items]}}.
	// Handle both shapes.
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("virtuals parse: %w", err)
	}

	type item struct {
		TokenAddress string `json:"tokenAddress"`
		Chain        string `json:"chain"`
	}

	var items []item
	if err := json.Unmarshal(envelope.Data, &items); err != nil {
		// try nested {"data": [...]}
		var nested struct {
			Data []item `json:"data"`
		}
		if err2 := json.Unmarshal(envelope.Data, &nested); err2 != nil {
			return nil, fmt.Errorf("virtuals parse nested: %w", err2)
		}
		items = nested.Data
	}

	var out []boostEntry
	seen := map[string]bool{}
	for _, it := range items {
		if it.TokenAddress == "" {
			continue
		}
		k := strings.ToLower(it.TokenAddress)
		if seen[k] {
			continue
		}
		seen[k] = true
		chain := chainSlug(it.Chain)
		out = append(out, boostEntry{ChainId: chain, TokenAddress: it.TokenAddress, Venue: "virtuals"})
	}
	return out, nil
}
