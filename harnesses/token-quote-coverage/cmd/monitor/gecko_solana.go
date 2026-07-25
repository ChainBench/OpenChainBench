package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func fetchGeckoSolanaTokens(ctx context.Context, dexSlug, venue string) ([]boostEntry, error) {
	url := "https://api.geckoterminal.com/api/v2/networks/solana/dexes/" + dexSlug + "/pools?page=1"
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := dexClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("geckoterminal solana/%s: %w", dexSlug, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("geckoterminal solana/%s: status=%d", dexSlug, resp.StatusCode)
	}

	var result struct {
		Data []struct {
			Relationships struct {
				BaseToken struct {
					Data struct {
						ID string `json:"id"` // "solana_<address>"
					} `json:"data"`
				} `json:"base_token"`
			} `json:"relationships"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("geckoterminal solana/%s parse: %w", dexSlug, err)
	}

	var out []boostEntry
	seen := map[string]bool{}
	for _, pool := range result.Data {
		id := pool.Relationships.BaseToken.Data.ID
		if !strings.HasPrefix(id, "solana_") {
			continue
		}
		addr := id[7:]
		if seen[addr] {
			continue
		}
		seen[addr] = true
		out = append(out, boostEntry{ChainId: "solana", TokenAddress: addr, Venue: venue})
		if len(out) >= 20 {
			break
		}
	}
	return out, nil
}

// FetchMoonshotTokens returns recently-traded tokens on Moonshot (Solana).
func FetchMoonshotTokens(ctx context.Context) ([]boostEntry, error) {
	return fetchGeckoSolanaTokens(ctx, "moonshot", "moonshot")
}

// FetchMeteoraDLMMTokens returns recently-traded tokens on Meteora DBC (Solana).
func FetchMeteoraDLMMTokens(ctx context.Context) ([]boostEntry, error) {
	return fetchGeckoSolanaTokens(ctx, "meteora-dbc", "meteora-dbc")
}
