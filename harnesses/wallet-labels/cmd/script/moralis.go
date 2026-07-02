package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// moralisMinInterval gates the rate at which we call the Moralis
// /entities endpoint to keep daily compute-unit usage under the 40 k CU/
// day free-tier ceiling. Anchor-feeder loop produced ~5.6 k Moralis
// checks/day at ~25 CU each = ~140 k CU/day, which saturated the key by
// mid-morning and 90 % of subsequent calls returned 401 (auth_err). The
// floor here is the cadence needed to come in under 40 k CU:
//
//     40 000 CU / 25 CU per call ≈ 1 600 calls / day
//     86 400 s / 1 600 calls     ≈ 54 s between calls
//
// 58 s gives us a small safety margin (≈ 1 489 calls / day, ≈ 37 k CU)
// without leaving headroom unused. Override with
// MORALIS_MIN_INTERVAL_SECONDS for paid Moralis tiers.
//
// Throttled calls return early with a skipped flag rather than firing
// a guaranteed-401 request. The bench's success_ratio = success/checks
// stays statistically valid at ~1 500 checks/day (standard error ±1.3
// pp on a binomial proportion, versus ±0.7 pp at the previous 5 500/day
// rate — imperceptible on the page leaderboard).
var (
	moralisMinIntervalOnce sync.Once
	moralisMinInterval     time.Duration
	moralisLastCallMu      sync.Mutex
	moralisLastCallAt      time.Time
)

func loadMoralisMinInterval() {
	moralisMinIntervalOnce.Do(func() {
		moralisMinInterval = 58 * time.Second
		if v := strings.TrimSpace(os.Getenv("MORALIS_MIN_INTERVAL_SECONDS")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				moralisMinInterval = time.Duration(n) * time.Second
			}
		}
	})
}

// shouldSkipMoralisCall returns true when the previous call was too
// recent — the bench-time anchor feeder calls Moralis hundreds of times
// faster than the free-tier CU budget allows; throttling here avoids
// burning the daily quota in the first hour.
func shouldSkipMoralisCall() bool {
	loadMoralisMinInterval()
	if moralisMinInterval == 0 {
		return false
	}
	moralisLastCallMu.Lock()
	defer moralisLastCallMu.Unlock()
	if time.Since(moralisLastCallAt) < moralisMinInterval {
		return true
	}
	moralisLastCallAt = time.Now()
	return false
}

type MoralisProvider struct{ apiKey string }

func NewMoralisProvider(key string) *MoralisProvider { return &MoralisProvider{apiKey: key} }

func (p *MoralisProvider) Name() string { return "moralis" }

// Moralis Web3 Data API is EVM-only (no Solana wallet labels endpoint).
func (p *MoralisProvider) Supports(chain string) bool {
	return moralisChainSlug(chain) != ""
}

// moralisChainSlug maps our internal chain id to Moralis' `chain` query param.
func moralisChainSlug(chain string) string {
	switch chain {
	case "ethereum":
		return "eth"
	case "base":
		return "base"
	case "bnb":
		return "bsc"
	case "polygon":
		return "polygon"
	case "arbitrum":
		return "arbitrum"
	case "optimism":
		return "optimism"
	case "avalanche":
		return "avalanche"
	}
	return ""
}

// Moralis labels live in the /entities transaction enrichment, not a direct
// per-address lookup. We fetch the most recent tx for the address and pull
// the entity off the matching side.
func (p *MoralisProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	slug := moralisChainSlug(chain)
	if slug == "" || p.apiKey == "" {
		return res
	}
	// Daily CU budget gate. Skip silently — neither success nor error
	// gets recorded for the throttled cycle, so the bench's
	// success/checks ratio remains computed only over actually-issued
	// calls and the rate stays statistically valid.
	if shouldSkipMoralisCall() {
		res.Skipped = true
		return res
	}
	start := time.Now()
	u := "https://deep-index.moralis.io/api/v2.2/entities?chain=" + slug + "&address=" + address + "&limit=1"
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("X-API-Key", p.apiKey)
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
		Result []struct {
			FromAddress       string `json:"from_address"`
			FromAddressEntity string `json:"from_address_entity"`
			FromAddressLabel  string `json:"from_address_label"`
			ToAddress         string `json:"to_address"`
			ToAddressEntity   string `json:"to_address_entity"`
			ToAddressLabel    string `json:"to_address_label"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		res.Err = fmt.Errorf("parse: %w", err)
		return res
	}
	if len(body.Result) == 0 {
		return res
	}
	r := body.Result[0]
	addrLow := strings.ToLower(address)
	var entity, label string
	if strings.ToLower(r.FromAddress) == addrLow {
		entity, label = r.FromAddressEntity, r.FromAddressLabel
	} else if strings.ToLower(r.ToAddress) == addrLow {
		entity, label = r.ToAddressEntity, r.ToAddressLabel
	}
	if !genericLabel(entity) {
		res.Label = entity
		res.HasLabel = true
		res.Raw = map[string]any{"entity": entity, "label": label}
	}
	return res
}
