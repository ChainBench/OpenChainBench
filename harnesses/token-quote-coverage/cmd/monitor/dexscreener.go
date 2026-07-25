package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var dexClient = &http.Client{Timeout: 15 * time.Second}

// boostEntry is one item from /token-boosts/latest/v1 or a discovery source.
// Venue is pre-assigned when the source already knows the launchpad (e.g. Virtuals API).
// An empty Venue is resolved via Dexscreener pair enrichment.
type boostEntry struct {
	ChainId      string `json:"chainId"`
	TokenAddress string `json:"tokenAddress"`
	Venue        string // optional: pre-assigned venue slug
}

// FetchBoostedTokens calls the Dexscreener token-boosts endpoint and returns
// up to 30 tokens filtered to chains we support (solana, base, bsc).
func FetchBoostedTokens(ctx context.Context) ([]boostEntry, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.dexscreener.com/token-boosts/latest/v1", nil)
	if err != nil {
		return nil, err
	}
	resp, err := dexClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("dexscreener boosts: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("dexscreener boosts: status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var entries []boostEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("dexscreener boosts parse: %w", err)
	}

	supported := map[string]bool{"solana": true, "base": true, "bsc": true, "robinhood": true}
	var out []boostEntry
	seen := map[string]bool{}
	for _, e := range entries {
		if !supported[e.ChainId] {
			continue
		}
		key := e.ChainId + ":" + strings.ToLower(e.TokenAddress)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, e)
		if len(out) >= 30 {
			break
		}
	}
	return out, nil
}

// pairResp is the minimal shape of /latest/dex/tokens/{addresses}.
type pairResp struct {
	Pairs []struct {
		ChainId string `json:"chainId"`
		DexId   string `json:"dexId"`
		BaseToken struct {
			Address string `json:"address"`
		} `json:"baseToken"`
		QuoteToken struct {
			Address string `json:"address"`
		} `json:"quoteToken"`
	} `json:"pairs"`
}

const dexscreenerBatchSize = 30

// EnrichWithVenue resolves pair data for all entries in batches of 30
// (Dexscreener API limit) and returns a Token slice with Venue populated.
// Tokens with no pair data are skipped.
func EnrichWithVenue(ctx context.Context, entries []boostEntry) ([]Token, error) {
	if len(entries) == 0 {
		return nil, nil
	}

	type key struct{ chain, addr string }
	dexIdOf := map[key]string{}

	for i := 0; i < len(entries); i += dexscreenerBatchSize {
		end := i + dexscreenerBatchSize
		if end > len(entries) {
			end = len(entries)
		}
		batch := entries[i:end]

		addrs := make([]string, len(batch))
		for j, e := range batch {
			addrs[j] = e.TokenAddress
		}
		url := "https://api.dexscreener.com/latest/dex/tokens/" + strings.Join(addrs, ",")

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		resp, err := dexClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("dexscreener tokens: %w", err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != 200 {
			fmt.Printf("[dexscreener] batch %d-%d status=%d, skipping batch\n", i, end, resp.StatusCode)
			continue
		}

		var pr pairResp
		if err := json.Unmarshal(body, &pr); err != nil {
			fmt.Printf("[dexscreener] batch %d-%d parse error: %v\n", i, end, err)
			continue
		}

		for _, pair := range pr.Pairs {
			k := key{pair.ChainId, strings.ToLower(pair.BaseToken.Address)}
			if _, exists := dexIdOf[k]; !exists {
				dexIdOf[k] = pair.DexId
			}
		}
	}

	var tokens []Token
	for _, e := range entries {
		if e.Venue != "" {
			// Venue pre-assigned by discovery source; skip Dexscreener lookup.
			tokens = append(tokens, Token{Address: e.TokenAddress, Chain: e.ChainId, Venue: e.Venue})
			continue
		}
		k := key{e.ChainId, strings.ToLower(e.TokenAddress)}
		dexId, ok := dexIdOf[k]
		if !ok {
			continue
		}
		tokens = append(tokens, Token{
			Address: e.TokenAddress,
			Chain:   e.ChainId,
			Venue:   venueFromPair(e.ChainId, dexId),
		})
	}
	return tokens, nil
}
