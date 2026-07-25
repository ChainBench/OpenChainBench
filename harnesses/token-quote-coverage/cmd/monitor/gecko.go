package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// FetchNewBSCTokens returns base tokens from recently created pools on BSC
// via GeckoTerminal. Used as fallback since Four.meme API is not public.
func FetchNewBSCTokens(ctx context.Context) ([]boostEntry, error) {
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://api.geckoterminal.com/api/v2/networks/bsc/new_pools?page=1",
		nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := dexClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("geckoterminal bsc: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("geckoterminal bsc: status=%d", resp.StatusCode)
	}

	var result struct {
		Data []struct {
			Relationships struct {
				BaseToken struct {
					Data struct {
						ID string `json:"id"` // "bsc_0x..."
					} `json:"data"`
				} `json:"base_token"`
			} `json:"relationships"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("geckoterminal bsc parse: %w", err)
	}

	var out []boostEntry
	seen := map[string]bool{}
	for _, pool := range result.Data {
		id := pool.Relationships.BaseToken.Data.ID
		if !strings.HasPrefix(id, "bsc_") {
			continue
		}
		addr := id[4:]
		k := strings.ToLower(addr)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, boostEntry{ChainId: "bsc", TokenAddress: addr})
		if len(out) >= 20 {
			break
		}
	}
	return out, nil
}
