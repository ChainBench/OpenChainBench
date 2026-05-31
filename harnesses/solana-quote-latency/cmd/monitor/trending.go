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

// TrendingToken is one rotation entry. Symbol is for logs / debugging only;
// the mint is the canonical identity passed to every provider adapter.
type TrendingToken struct {
	Mint   string
	Symbol string
}

// TrendingFetcher is the rotation source the scheduler reads from. It holds
// two parallel populations:
//
//   - "pulse pool" — fed by PulseSubscriber via Note() / Forget() from the
//     live `wss://pulse-v2-api.mobula.io` bonded view. Each entry has a
//     `lastSeen` timestamp and is evicted from Pick after 30 min of silence.
//     This is the preferred source — it tracks what's actually trending right
//     now, refreshed on the millisecond.
//
//   - "rest fallback" — the older list fetched from
//     `api.mobula.io/api/1/market/query?sortBy=volume&offset=5&limit=50` every
//     10 min. Used ONLY when the Pulse WS hasn't seen a message in > 90 s
//     (initial connection delay, network blip, Mobula incident). Without this
//     safety net the bench would stall during any Pulse outage.
//
// Pick() prefers pulse when it has fresh entries and falls through to the
// REST snapshot otherwise. The scheduler never has to branch.
const (
	trendingFetchEndpoint    = "https://api.mobula.io/api/1/market/query"
	trendingSkipTop          = 5 // skip USDC, USDT, CBBTC, SOL, USD1
	trendingFetchLimit       = 50
	trendingRefreshEvery     = 10 * time.Minute
	trendingMinLiquidity     = 50_000.0
	pulseEntryTTL            = 30 * time.Minute // entries older than this stop appearing in Pick
)

// stablecoinSymbols mirrors the stablecoin filter applied to the REST snapshot
// — the Pulse bonded view occasionally emits a stable graduating from a
// launchpad too, and quoting USDC → USDC defeats the purpose.
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

type pulseEntry struct {
	mint     string
	symbol   string
	lastSeen time.Time
}

type TrendingFetcher struct {
	apiKey string
	client *http.Client

	mu sync.RWMutex
	// rest snapshot (background refresh from /market/query)
	restTokens []TrendingToken
	// pulse-fed pool keyed by mint
	pulse map[string]*pulseEntry

	// lastRESTLoad / lastPulseAt track how fresh each source is.
	lastRESTLoad time.Time
}

func NewTrendingFetcher(apiKey string) *TrendingFetcher {
	return &TrendingFetcher{
		apiKey: apiKey,
		client: newWarmHTTPClient(),
		pulse:  make(map[string]*pulseEntry),
	}
}

// Note records that the Pulse bonded view saw this token. Called from the WS
// subscriber's goroutine on every `update-token` / `new-token` event. Skips
// stablecoin symbols and the canonical pair anchors (SOL, USDC).
func (f *TrendingFetcher) Note(mint, symbol string) {
	if mint == "" || mint == solMint || mint == usdcMint {
		return
	}
	if stablecoinSymbols[symbol] {
		return
	}
	now := time.Now()
	f.mu.Lock()
	if e, ok := f.pulse[mint]; ok {
		e.lastSeen = now
		if e.symbol == "" && symbol != "" {
			e.symbol = symbol
		}
	} else {
		f.pulse[mint] = &pulseEntry{mint: mint, symbol: symbol, lastSeen: now}
	}
	f.mu.Unlock()
}

// Forget drops a token from the pulse pool. Called when Pulse emits
// `remove-token` (the bonded view shrunk past this entry).
func (f *TrendingFetcher) Forget(mint string) {
	f.mu.Lock()
	delete(f.pulse, mint)
	f.mu.Unlock()
}

// pulseLive returns the subset of pulse entries seen within pulseEntryTTL.
// Also opportunistically prunes anything older.
func (f *TrendingFetcher) pulseLive() []TrendingToken {
	now := time.Now()
	cutoff := now.Add(-pulseEntryTTL)
	out := make([]TrendingToken, 0, len(f.pulse))
	for mint, e := range f.pulse {
		if e.lastSeen.Before(cutoff) {
			delete(f.pulse, mint)
			continue
		}
		out = append(out, TrendingToken{Mint: e.mint, Symbol: e.symbol})
	}
	return out
}

// Pick returns one random token from the freshest available source. Tries the
// Pulse pool first; falls through to the REST snapshot when Pulse is empty.
func (f *TrendingFetcher) Pick() (TrendingToken, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if live := f.pulseLive(); len(live) > 0 {
		return live[rand.Intn(len(live))], true
	}
	if len(f.restTokens) > 0 {
		return f.restTokens[rand.Intn(len(f.restTokens))], true
	}
	return TrendingToken{}, false
}

// Stats returns counts for logging.
func (f *TrendingFetcher) Stats() (pulseLive, restCount int) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	cutoff := time.Now().Add(-pulseEntryTTL)
	for _, e := range f.pulse {
		if !e.lastSeen.Before(cutoff) {
			pulseLive++
		}
	}
	restCount = len(f.restTokens)
	return
}

// RefreshREST pulls the long-tail-by-volume snapshot. Used as fallback when
// the Pulse WS is down. Keeps the prior list on failure so we don't stall.
func (f *TrendingFetcher) RefreshREST(ctx context.Context) error {
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
		return fmt.Errorf("rest fetch (%s): %w", errType, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("rest http %d", resp.StatusCode)
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
		var solAddr string
		for _, c := range t.Contracts {
			if c.Blockchain == "solana:solana" {
				solAddr = c.Address
				break
			}
		}
		if solAddr == "" || solAddr == solMint || solAddr == usdcMint {
			continue
		}
		out = append(out, TrendingToken{Mint: solAddr, Symbol: t.Symbol})
	}
	if len(out) == 0 {
		return fmt.Errorf("rest: 0 tradable tokens after filter")
	}

	f.mu.Lock()
	f.restTokens = out
	f.lastRESTLoad = time.Now()
	f.mu.Unlock()
	fmt.Printf("[TRENDING][REST] fallback list refreshed: %d tokens\n", len(out))
	return nil
}

// RunREST keeps the REST snapshot warm on a 10-min cycle. The Pulse WS feeds
// the primary pool; this is the safety net.
func (f *TrendingFetcher) RunREST(ctx context.Context) {
	doRefresh := func() {
		c, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err := f.RefreshREST(c); err != nil {
			fmt.Printf("[TRENDING][REST] refresh failed: %v (keeping prior list)\n", err)
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
