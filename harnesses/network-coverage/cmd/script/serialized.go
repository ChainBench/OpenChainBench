package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Serialized publishes its chain list at GET /v1/meta/chains. The endpoint
// is free (0 credits) and returns one row per chain with a `status` field.
//
// The same list answers both benches this harness feeds: Serialized runs its
// own indexers and does not separate "chains where we know tokens" from
// "chains where we index DEX pools" — every listed chain carries both. So
// the count is identical on bench 005 and bench 090 by construction, which
// is worth knowing when reading the two leaderboards side by side.
const serializedChainsURL = "https://api.serialized.xyz/v1/meta/chains"

type serializedChain struct {
	Chain  string `json:"chain"` // "evm:8453" or "solana"
	Name   string `json:"name"`
	Slug   string `json:"slug"`
	Family string `json:"family"`
	Status string `json:"status"`
}

type serializedChainsResponse struct {
	Data []serializedChain `json:"data"`
}

func fetchSerialized(cfg *Config) ProviderResult {
	res := ProviderResult{Provider: "serialized"}
	if cfg.SerializedAPIKey == "" {
		res.Err = "missing_api_key"
		return res
	}

	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", serializedChainsURL, nil)
	// Raw key, no Bearer prefix — a prefixed key is rejected with 401.
	req.Header.Set("Authorization", cfg.SerializedAPIKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		res.Err = fmt.Sprintf("request_error: %v", err)
		return res
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		res.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		return res
	}

	var parsed serializedChainsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}

	for _, c := range parsed.Data {
		// Only chains the provider declares live. Everything on this
		// endpoint is mainnet, so no testnet filter is needed, but a
		// future "beta"/"deprecated" status must not inflate the count.
		if c.Status != "live" {
			continue
		}
		res.Networks = append(res.Networks, Network{
			ChainID: c.Chain,
			Slug:    c.Slug,
			Name:    c.Name,
		})
	}

	return res
}
