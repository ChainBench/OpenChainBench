package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type MobulaProvider struct {
	apiKey string
}

func NewMobulaProvider(key string) *MobulaProvider { return &MobulaProvider{apiKey: key} }

func (p *MobulaProvider) Name() string { return "mobula" }

// Mobula advertises 90+ chains. We treat it as supports-all since the
// per-chain breakdown is computed from the response (entityType etc.).
func (p *MobulaProvider) Supports(chain string) bool { return true }

// We use POST /api/1/wallet/labels (per docs.mobula.io). The /api/2/ GET
// variant returns 500 on some non-EVM addresses (Stellar) and on a specific
// BNB hot wallet — v1 handles both cleanly. Body schema is identical.
func (p *MobulaProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	start := time.Now()
	payload, _ := json.Marshal(map[string]any{"walletAddresses": []string{address}})
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.mobula.io/api/1/wallet/labels", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", p.apiKey)
	}
	resp, err := httpClient.Do(req)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Err = err
		return res
	}
	defer resp.Body.Close()
	// v1 returns 201 on success.
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		res.Err = fmt.Errorf("status_%d", resp.StatusCode)
		return res
	}
	var body struct {
		Data []struct {
			WalletAddress  string   `json:"walletAddress"`
			Labels         []string `json:"labels"`
			WalletMetadata *struct {
				EntityName   string   `json:"entityName"`
				EntityLabels []string `json:"entityLabels"`
				EntityType   string   `json:"entityType"`
			} `json:"walletMetadata"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if len(body.Data) == 0 {
		return res
	}
	r := body.Data[0]
	// Pick the first non-generic signal we can find:
	//   1. walletMetadata.entityName   (canonical entity, e.g. "Binance")
	//   2. walletMetadata.entityLabels (e.g. "Wrapped Ether (WETH)")
	//   3. labels[]                    (e.g. ["Sanctioned"])
	var pick string
	if r.WalletMetadata != nil && !genericLabel(r.WalletMetadata.EntityName) {
		pick = r.WalletMetadata.EntityName
	}
	if pick == "" && r.WalletMetadata != nil {
		for _, l := range r.WalletMetadata.EntityLabels {
			if !genericLabel(l) {
				pick = l
				break
			}
		}
	}
	if pick == "" {
		for _, l := range r.Labels {
			if !genericLabel(l) {
				pick = l
				break
			}
		}
	}
	if pick != "" {
		res.Label = pick
		res.HasLabel = true
		entityType := ""
		if r.WalletMetadata != nil {
			entityType = r.WalletMetadata.EntityType
		}
		res.Raw = map[string]any{"label": pick, "type": entityType}
	}
	return res
}
