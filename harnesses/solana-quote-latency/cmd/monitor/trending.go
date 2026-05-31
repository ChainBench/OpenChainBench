package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// TrendingToken is one rotation entry. Symbol is only for logs / debugging;
// the mint is what every provider takes.
type TrendingToken struct {
	Mint   string
	Symbol string
}

// trendingFetchEndpoint queries Mobula market-query sorted by volume DESC and
// skips the top N to dodge the always-cached pairs (USDC, USDT, CBBTC, SOL).
// What's left is real tradable long-tail volume — the kind a swap UI quotes
// when a user picks a memecoin or a wrapped asset, where no provider can serve
// from edge cache.
const (
	trendingFetchEndpoint = "https://api.mobula.io/api/1/market/query"
	trendingSkipTop       = 5  // skip USDC, USDT, CBBTC, SOL, USD1
	trendingFetchLimit    = 50 // ranks 6..55 by volume on Solana
	trendingRefreshEvery  = 10 * time.Minute
	trendingMinLiquidity  = 50_000.0 // USD — drop dust tokens with no routable path
)

// stablecoinSymbols is the set we skip even if they show up in the rank window.
// They behave like cached pairs (issuers + market-makers run the same canonical
// quote a lot) so they bias the latency the same way SOL↔USDC did.
var stablecoinSymbols = map[string]bool{
	"USDC": true, "USDT": true, "USD1": true, "USDG": true, "USDE": true,
	"DAI": true, "FDUSD": true, "PYUSD": true, "USDD": true, "USDS": true,
}

type mobulaQueryResp []struct {
	Symbol    string  `json:"symbol"`
	Liquidity float64 `json:"liquidity"`
	Contracts []struct {
		Address    string `json:"address"`
		Blockchain string `json:"blockchain"`
	} `json:"contracts"`
}

type TrendingFetcher struct {
	apiKey string
	client *http.Client

	mu       sync.RWMutex
	tokens   []TrendingToken
	lastLoad time.Time
}

func NewTrendingFetcher(apiKey string) *TrendingFetcher {
	return &TrendingFetcher{apiKey: apiKey, client: newWarmHTTPClient()}
}

// Refresh pulls a fresh list. Safe to call concurrently; only one fetch lands.
// On any failure the prior list is kept (so a transient Mobula hiccup doesn't
// empty the rotation and stop the bench).
func (f *TrendingFetcher) Refresh(ctx context.Context) error {
	q := url.Values{}
	q.Set("sortBy", "volume")
	q.Set("sortOrder", "desc")
	q.Set("blockchain", "Solana")
	q.Set("limit", fmt.Sprintf("%d", trendingFetchLimit))
	q.Set("offset", fmt.Sprintf("%d", trendingSkipTop))

	fullURL := trendingFetchEndpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if f.apiKey != "" {
		req.Header.Set("Authorization", f.apiKey)
	}

	resp, err := f.client.Do(req)
	if err != nil {
		errType := "network"
		if errors.Is(err, context.DeadlineExceeded) {
			errType = "timeout"
		}
		return fmt.Errorf("trending fetch (%s): %w", errType, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("trending http %d", resp.StatusCode)
	}

	var parsed mobulaQueryResp
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("parse: %w", err)
	}

	var out []TrendingToken
	for _, t := range parsed {
		if stablecoinSymbols[t.Symbol] {
			continue
		}
		if t.Liquidity < trendingMinLiquidity {
			continue
		}
		var solMintAddr string
		for _, c := range t.Contracts {
			if c.Blockchain == "solana:solana" {
				solMintAddr = c.Address
				break
			}
		}
		if solMintAddr == "" {
			continue
		}
		if solMintAddr == solMint || solMintAddr == usdcMint {
			continue
		}
		out = append(out, TrendingToken{Mint: solMintAddr, Symbol: t.Symbol})
	}
	if len(out) == 0 {
		return fmt.Errorf("trending: 0 tradable long-tail tokens after filter")
	}

	f.mu.Lock()
	f.tokens = out
	f.lastLoad = time.Now()
	f.mu.Unlock()
	fmt.Printf("[TRENDING] refreshed list: %d tokens (first=%s, last=%s)\n",
		len(out), out[0].Symbol, out[len(out)-1].Symbol)
	return nil
}

// Pick returns one random token from the current list. Returns ok=false when
// the list is empty (first call before Refresh succeeded).
func (f *TrendingFetcher) Pick() (TrendingToken, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if len(f.tokens) == 0 {
		return TrendingToken{}, false
	}
	return f.tokens[rand.Intn(len(f.tokens))], true
}

// Run blocks until ctx is done; refreshes the list immediately on entry and
// every trendingRefreshEvery thereafter. Logs failures but doesn't exit.
func (f *TrendingFetcher) Run(ctx context.Context) {
	doRefresh := func() {
		refreshCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err := f.Refresh(refreshCtx); err != nil {
			fmt.Printf("[TRENDING] refresh failed: %v (keeping prior list of %d tokens)\n",
				err, len(f.tokens))
		}
	}
	doRefresh()
	t := time.NewTicker(trendingRefreshEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			doRefresh()
		}
	}
}
