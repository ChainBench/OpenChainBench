package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// BubblemapsProvider reads GET /v0/addresses/metadata/{address}.
//
// Three things about them decide how this adapter is shaped, and all three
// were measured against the live API on 2026-11-09 rather than taken from
// the docs.
//
// Their endpoint takes NO chain. One address, one answer, whatever chain you
// had in mind. That is fine for a Binance hot wallet, which is Binance
// everywhere, and it is a real limit on predeploys: 0x4200..0006 is WETH on
// Base, Optimism and Mantle at the same address, and they answer "Mantle".
// The Venus Comptroller on BNB comes back "Ethereum Foundation Congress" for
// the same reason. Those are not label errors so much as a question their
// API cannot be asked, and the chains below are declared knowing it.
//
// Their /v0/chains lists `ton`, and the address endpoint rejects a TON
// address outright with "Invalid account address". Chain list and address
// endpoint disagree, so ton is NOT declared here.
//
// And the budget is the real constraint. The key carries 30 000 credits a
// month, one credit per address, and the feeder pushes all 163 anchors every
// 30 minutes. Asking on every pass would spend 235 000 a month, eight times
// the quota, and burn it in under four days.
type BubblemapsProvider struct{ apiKey string }

func NewBubblemapsProvider(apiKey string) *BubblemapsProvider {
	return &BubblemapsProvider{apiKey: apiKey}
}

func (p *BubblemapsProvider) Name() string { return "bubblemaps" }

// The six our anchors live on that their ADDRESS endpoint actually accepts.
// Their /v0/chains also returns tron, avalanche, sonic, hyperevm, monad,
// robinhood and arc, which this bench has no anchors for, and ton, which it
// has anchors for and they reject.
var bubblemapsChains = map[string]bool{
	"ethereum": true,
	"base":     true,
	"bnb":      true,
	"polygon":  true,
	"arbitrum": true,
	"solana":   true,
}

func (p *BubblemapsProvider) Supports(chain string) bool {
	return bubblemapsChains[chain]
}

// bubblemapsEvery is how often one address may be put to them.
//
// 163 anchors at 1 credit each is 652 credits a day at this interval, about
// 19 600 a month against a 30 000 quota, so a third is left for retries. At
// four hours it would be 98% of the quota and a single bad day would push
// them into 429s, which would read on the board as missing coverage rather
// than as our own impatience.
//
// Skipping rather than caching is deliberate: a skipped call records neither
// a check nor an error, so the published rate stays computed over calls we
// actually made, and the board never shows a label we did not just receive.
const bubblemapsEvery = 6 * time.Hour

var (
	bubblemapsMu   sync.Mutex
	bubblemapsSeen = map[string]time.Time{}
)

// bubblemapsDue reports whether this address is outside its window, and
// claims the slot if so. Keyed by address and not by (chain, address),
// because their API has no chain and asking twice for one address would
// spend two credits on one answer.
func bubblemapsDue(address string) bool {
	k := strings.ToLower(address)
	bubblemapsMu.Lock()
	defer bubblemapsMu.Unlock()
	if last, ok := bubblemapsSeen[k]; ok && time.Since(last) < bubblemapsEvery {
		return false
	}
	bubblemapsSeen[k] = time.Now()
	return true
}

func (p *BubblemapsProvider) Lookup(ctx context.Context, chain, address string) LabelResult {
	res := LabelResult{Provider: p.Name(), Chain: chain, Address: address}
	if p.apiKey == "" || !p.Supports(chain) {
		return res
	}
	if !bubblemapsDue(address) {
		res.Skipped = true
		return res
	}

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://api.bubblemaps.io/v0/addresses/metadata/"+address, nil)
	if err != nil {
		res.Err = err
		return res
	}
	req.Header.Set("X-ApiKey", p.apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Err = err
		return res
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	// A 422 is them refusing the address FORMAT, not failing to label it.
	// Counting it as an error would blame the vendor for a question we
	// should not have asked; counting it as a miss would be a measurement.
	// It is the latter: we asked, they have nothing for this address.
	if resp.StatusCode == 422 {
		return res
	}
	if resp.StatusCode != 200 {
		res.Err = fmt.Errorf("status_%d", resp.StatusCode)
		return res
	}

	var r struct {
		Address        string `json:"address"`
		AddressDetails struct {
			Label      *string `json:"label"`
			IsContract bool    `json:"is_contract"`
			IsCex      bool    `json:"is_cex"`
			IsDex      bool    `json:"is_dex"`
			EntityID   *string `json:"entity_id"`
		} `json:"address_details"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		res.Err = err
		return res
	}
	if r.AddressDetails.Label != nil {
		res.Label = strings.TrimSpace(*r.AddressDetails.Label)
	}
	res.HasLabel = res.Label != "" && !genericLabel(res.Label)
	res.Raw = map[string]any{
		"is_contract": r.AddressDetails.IsContract,
		"is_cex":      r.AddressDetails.IsCex,
		"is_dex":      r.AddressDetails.IsDex,
	}
	return res
}
