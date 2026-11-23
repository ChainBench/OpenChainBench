package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Metastreams has no per-address label endpoint. Identities come back on
// GET /v1/positions, attached to each position row (`identities`, with a
// `source` such as codex, axiom, pump or arkham). So a wallet with no
// position, open or closed, can never carry a label here: most contracts
// on the anchor list hold none. That is the product today, measured as is.
//
// One credit per wallet per call. The open read goes first; only when it
// names no identity is the closed read tried, so an anchor costs one or
// two credits per 30-minute pass (34 Solana and BNB anchors: at most about
// 3,300 a day).
type MetastreamsProvider struct {
	apiKey string
}

func NewMetastreamsProvider(key string) *MetastreamsProvider {
	return &MetastreamsProvider{apiKey: key}
}

func (p *MetastreamsProvider) Name() string { return "metastreams" }

// Metastreams' spot chains that are on the anchor list. Robinhood Chain is
// covered by Metastreams but has no anchors.
var metastreamsChains = map[string]bool{"solana": true, "bnb": true}

func (p *MetastreamsProvider) Supports(chain string) bool { return metastreamsChains[chain] }

func (p *MetastreamsProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if !p.Supports(chain) || p.apiKey == "" {
		return res
	}
	start := time.Now()
	for _, lifecycle := range []string{"open", "closed"} {
		label, err := p.identity(ctx, address, lifecycle)
		if err != nil {
			res.LatencyMs = time.Since(start).Milliseconds()
			res.Err = err
			return res
		}
		if label != "" {
			res.HasLabel = true
			res.Label = label
			break
		}
	}
	res.LatencyMs = time.Since(start).Milliseconds()
	return res
}

func (p *MetastreamsProvider) identity(ctx context.Context, address, lifecycle string) (string, error) {
	u := "https://api.metastreams.io/v1/positions?limit=1&lifecycle=" + lifecycle + "&wallets=" + url.QueryEscape(address)
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status_%d", resp.StatusCode)
	}
	var body struct {
		Positions []struct {
			Identities []struct {
				DisplayName *string `json:"displayName"`
				Handle      *string `json:"handle"`
			} `json:"identities"`
		} `json:"positions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}
	return firstIdentity(body.Positions), nil
}

func firstIdentity(rows []struct {
	Identities []struct {
		DisplayName *string `json:"displayName"`
		Handle      *string `json:"handle"`
	} `json:"identities"`
}) string {
	for _, r := range rows {
		for _, id := range r.Identities {
			for _, c := range []*string{id.DisplayName, id.Handle} {
				if c != nil && !genericLabel(*c) {
					return *c
				}
			}
		}
	}
	return ""
}
