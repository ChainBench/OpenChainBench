package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Serialized exposes an identity graph rather than a pure entity-label
// service: GET /v1/wallet/profile returns a display name, ENS / Basename /
// .sol resolution, socials and linked wallets for an address.
//
// We read it with the same precedence rule every other provider gets —
// first non-generic name signal wins — so the bench compares like with
// like. Note for whoever reads the leaderboard: because `displayName`
// can resolve to a personal name-service record rather than a curated
// entity, a share of Serialized's hits name the *holder* of an address
// rather than the *entity* behind it (a measured ~25% of hits at
// onboarding time, against ~25% for Mobula on the same sample). That is
// a property of the bench's hit rule, not of this provider, and the fix
// belongs in the scoring rule for everyone at once. See
// docs/methodology/serialized-onboarding-audit.md §5.
type SerializedProvider struct {
	apiKey string
}

func NewSerializedProvider(key string) *SerializedProvider {
	return &SerializedProvider{apiKey: key}
}

func (p *SerializedProvider) Name() string { return "serialized" }

// serializedChains are the anchor-list chains Serialized indexes. Their
// full surface is 18 EVM chains plus Solana; the ones below are the
// intersection with the curated anchor sample. Chains outside this set
// are skipped rather than counted as misses, same as every other
// chain-restricted provider in this harness.
var serializedChains = map[string]bool{
	"ethereum": true,
	"bnb":      true,
	"base":     true,
	"arbitrum": true,
	"solana":   true,
}

func (p *SerializedProvider) Supports(chain string) bool { return serializedChains[chain] }

// Serialized enforces a hard burst cap of 40 requests per second per key
// and answers anything above it with 429. The harness runs 8 workers with
// sub-100ms responses, which clears that cap easily and silently turns
// coverage into a rate-limit artifact (measured: 60 of 100 anchors lost to
// 429, dropping apparent coverage from 77% to 37%). Serialize the calls at
// a conservative fixed interval instead of relying on worker count.
var (
	serializedMu   sync.Mutex
	serializedLast time.Time
)

const serializedMinInterval = 60 * time.Millisecond // ~16 rps, well under the 40 rps cap

func serializedThrottle() {
	serializedMu.Lock()
	defer serializedMu.Unlock()
	if wait := time.Until(serializedLast.Add(serializedMinInterval)); wait > 0 {
		time.Sleep(wait)
	}
	serializedLast = time.Now()
}

func (p *SerializedProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if !p.Supports(chain) || p.apiKey == "" {
		return res
	}

	serializedThrottle()

	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, "GET",
		"https://api.serialized.xyz/v1/wallet/profile?address="+address, nil)
	// Raw key, no Bearer prefix — a prefixed key is rejected with 401.
	req.Header.Set("Authorization", p.apiKey)
	req.Header.Set("Accept", "application/json")

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
			Profile *struct {
				DisplayName string `json:"displayName"`
				ENSName     string `json:"ensName"`
				Basename    string `json:"basename"`
				SolName     string `json:"solName"`
			} `json:"profile"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if body.Data.Profile == nil {
		return res
	}

	prof := body.Data.Profile
	for _, candidate := range []string{prof.DisplayName, prof.ENSName, prof.Basename, prof.SolName} {
		if !genericLabel(candidate) {
			res.Label = candidate
			res.HasLabel = true
			res.Raw = map[string]any{"label": candidate, "source": "wallet_profile"}
			break
		}
	}
	return res
}
