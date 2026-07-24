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

// boostEntry is one item from /token-boosts/latest/v1.
type boostEntry struct {
	ChainId      string `json:"chainId"`
	TokenAddress string `json:"tokenAddress"`
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

	supported := map[string]bool{"solana": true, "base": true, "bsc": true}
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

// EnrichWithVenue batch-looks up pair data for up to 30 tokens and returns
// a Token slice with Venue populated. Tokens with no pair data are skipped.
func EnrichWithVenue(ctx context.Context, entries []boostEntry) ([]Token, error) {
	if len(entries) == 0 {
		return nil, nil
	}

	// Build comma-sep address list. Dexscreener accepts up to 30.
	addrs := make([]string, len(entries))
	for i, e := range entries {
		addrs[i] = e.TokenAddress
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
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("dexscreener tokens: status=%d body=%s", resp.StatusCode, snippet(body))
	}
	var pr pairResp
	if err := json.Unmarshal(body, &pr); err != nil {
		return nil, fmt.Errorf("dexscreener tokens parse: %w", err)
	}

	// Build index: lower(tokenAddress) -> first pair's dexId for that chain.
	type key struct{ chain, addr string }
	dexIdOf := map[key]string{}
	for _, pair := range pr.Pairs {
		k := key{pair.ChainId, strings.ToLower(pair.BaseToken.Address)}
		if _, exists := dexIdOf[k]; !exists {
			dexIdOf[k] = pair.DexId
		}
	}

	var tokens []Token
	for _, e := range entries {
		k := key{e.ChainId, strings.ToLower(e.TokenAddress)}
		dexId, ok := dexIdOf[k]
		if !ok {
			fmt.Printf("[dexscreener] no pair data for %s on %s, skipping\n", e.TokenAddress, e.ChainId)
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
