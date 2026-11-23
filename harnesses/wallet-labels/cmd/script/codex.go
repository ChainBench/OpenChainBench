package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Codex names a wallet through its read-only `wallets` GraphQL query, as
// `displayName`: a hand-entered name, else its own records (exchange and
// protocol wallets from its entity registry, OFAC SDN entries, tokens,
// DEX contracts, treasuries, Safe deployments, public figures), else a
// primary ENS or SNS name, else a verified contract name.
//
// A name is looked up on the anchor's chain: a contract's name belongs to
// the chain it was deployed on, and the same address can be a different
// contract elsewhere. Read with the same rule every other provider gets:
// a non-generic `displayName` is a hit.
type CodexProvider struct {
	apiKey string
}

func NewCodexProvider(key string) *CodexProvider {
	return &CodexProvider{apiKey: key}
}

func (p *CodexProvider) Name() string { return "codex" }

// codexNetworks are the anchor-list chains Codex indexes, keyed to its
// network ids. Chains outside this set are skipped rather than counted as
// misses, same as every other chain-restricted provider in this harness.
var codexNetworks = map[string]int{
	"ethereum": 1,
	"bnb":      56,
	"base":     8453,
	"arbitrum": 42161,
	"optimism": 10,
	"polygon":  137,
	"solana":   1399811149,
}

func (p *CodexProvider) Supports(chain string) bool {
	_, ok := codexNetworks[chain]
	return ok
}

// A var so the tests can point it at a local server.
var codexGraphQLURL = "https://graph.codex.io/graphql"

const codexWalletsQuery = `query WalletName($input: WalletsInput!) { wallets(input: $input) { displayName } }`

// No client-side throttle: the feeder sends one anchor about every 10 s.
func (p *CodexProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	networkID, ok := codexNetworks[chain]
	if !ok || p.apiKey == "" {
		return res
	}

	payload, _ := json.Marshal(map[string]any{
		"query": codexWalletsQuery,
		"variables": map[string]any{
			"input": map[string]any{
				"walletAddresses": []string{address},
				"networkId":       networkID,
			},
		},
	})

	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, "POST", codexGraphQLURL, bytes.NewReader(payload))
	// Raw key, no Bearer prefix — a prefixed API key is rejected with 401.
	req.Header.Set("Authorization", p.apiKey)
	req.Header.Set("Content-Type", "application/json")

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
		Data struct {
			Wallets []*struct {
				DisplayName string `json:"displayName"`
			} `json:"wallets"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if len(body.Errors) > 0 {
		res.Err = fmt.Errorf("graphql: %s", body.Errors[0].Message)
		return res
	}
	// `wallets` returns null for an address Codex has no record of.
	if len(body.Data.Wallets) == 0 || body.Data.Wallets[0] == nil {
		return res
	}

	if name := body.Data.Wallets[0].DisplayName; !genericLabel(name) {
		res.Label = name
		res.HasLabel = true
		res.Raw = map[string]any{"label": name, "source": "wallets.displayName"}
	}
	return res
}
