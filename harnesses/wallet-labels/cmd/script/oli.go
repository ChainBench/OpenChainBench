package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// OLI — Open Labels Initiative. Attestations live on Base via EAS. We query
// the public EASScan GraphQL endpoint, no auth required. The OLI tag schema
// id is fixed across all attestations.
const oliSchemaID = "0xb763e62d940bed6f527dd82418e146a904e62a297b8fa765c9b3e1f0bc6fdd68"

type OLIProvider struct{}

func NewOLIProvider() *OLIProvider { return &OLIProvider{} }

func (p *OLIProvider) Name() string { return "oli" }

// OLI uses chain_id values like "eip155:1". Solana uses "solana:..."  but
// the bulk of attestations is EVM right now, so we map the same chain ids
// to the EVM CAIP-style strings. Unmapped chains return false to keep the
// per-chain leaderboards honest.
func (p *OLIProvider) Supports(chain string) bool { return oliCAIP(chain) != "" }

func oliCAIP(chain string) string {
	switch chain {
	case "ethereum":
		return "eip155:1"
	case "base":
		return "eip155:8453"
	case "optimism":
		return "eip155:10"
	case "arbitrum":
		return "eip155:42161"
	case "bnb":
		return "eip155:56"
	case "polygon":
		return "eip155:137"
	}
	return ""
}

func (p *OLIProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	caip := oliCAIP(chain)
	if caip == "" {
		return res
	}
	// EAS recipient is checksummed but query is case-insensitive in `equals`
	// when the value matches what was stored. We just upper-case-prefix-0x
	// and let EAS match.
	q := fmt.Sprintf(`{"query":"{ attestations(where: { schemaId: { equals: \"%s\" } recipient: { equals: \"%s\" } }, take: 5) { id attester decodedDataJson } }"}`,
		oliSchemaID, address)
	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://base.easscan.org/graphql", bytes.NewReader([]byte(q)))
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
			Attestations []struct {
				DecodedDataJSON string `json:"decodedDataJson"`
			} `json:"attestations"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if len(body.Data.Attestations) == 0 {
		return res
	}
	// Iterate attestations, pick the first non-generic name we find. The
	// decoded JSON is a list of {name, value} pairs; tags_json holds the
	// useful payload as a stringified JSON object with keys like
	// `contract_name`, `owner_project`.
	var pick string
	for _, a := range body.Data.Attestations {
		var fields []struct {
			Name  string `json:"name"`
			Value struct {
				Value any `json:"value"`
			} `json:"value"`
		}
		if err := json.Unmarshal([]byte(a.DecodedDataJSON), &fields); err != nil {
			continue
		}
		var caipMatched bool
		var tags string
		for _, f := range fields {
			vs, _ := f.Value.Value.(string)
			switch f.Name {
			case "chain_id":
				if vs == caip {
					caipMatched = true
				}
			case "tags_json":
				tags = vs
			}
		}
		if !caipMatched || tags == "" {
			continue
		}
		var tagMap map[string]any
		if err := json.Unmarshal([]byte(tags), &tagMap); err != nil {
			continue
		}
		for _, key := range []string{"contract_name", "owner_project", "name", "label"} {
			if v, ok := tagMap[key]; ok {
				if s, ok := v.(string); ok && !genericLabel(s) {
					pick = s
					break
				}
			}
		}
		if pick != "" {
			break
		}
	}
	if pick != "" {
		res.Label = strings.TrimSpace(pick)
		res.HasLabel = true
		res.Raw = map[string]any{"label": pick, "attestations": len(body.Data.Attestations)}
	}
	return res
}
