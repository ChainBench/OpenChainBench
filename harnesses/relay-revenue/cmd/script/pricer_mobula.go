package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// pricer_mobula.go — Mobula price oracle implementation. Preferred over
// the CoinGecko fallback because:
//   - Larger long-tail coverage (Relay routes through ~24 chains, many of
//     which CoinGecko doesn't price natively — Mobula's indexer does)
//   - Sub-15s freshness vs CG free-tier ~60s
//   - No rate-limit concerns for our 1/min polling cadence
//   - Methodology-defensible: "we use Mobula's own oracle" rather than
//     a third-party with its own quirks
//
// Activated when MOBULA_API_KEY is set. Falls back to CoinGecko otherwise.

const (
	mobulaBaseURL = "https://api.mobula.io/api/1"
	mobulaHTTPTO  = 8 * time.Second
)

// MobulaPricer talks to https://api.mobula.io for USD prices via two
// query shapes against the same /market/data endpoint:
//   PriceUSD       → asset=<slug>                  (e.g. "ethereum")
//   PriceTokenUSD  → asset=<addr>&blockchain=<slug> (any ERC-20 / SPL)
type MobulaPricer struct {
	apiKey  string
	baseURL string
	http    *http.Client
	mu      sync.Mutex
	cache   map[string]cachedPrice
	now     func() time.Time
}

// NewMobulaPricer reads MOBULA_API_KEY from env. Returns (nil, false) if
// no key is set so the caller can fall back cleanly.
func NewMobulaPricer() (*MobulaPricer, bool) {
	key := strings.TrimSpace(os.Getenv("MOBULA_API_KEY"))
	if key == "" {
		return nil, false
	}
	return &MobulaPricer{
		apiKey:  key,
		baseURL: mobulaBaseURL,
		http:    &http.Client{Timeout: mobulaHTTPTO},
		cache:   map[string]cachedPrice{},
		now:     time.Now,
	}, true
}

// PriceUSD: stable peg short-circuit → cache → Mobula upstream.
// The `coingeckoID` parameter doubles as the Mobula `asset` slug here
// since both APIs share CoinMarketCap-style slugs for major tokens
// (ethereum, usd-coin, solana, matic-network, etc.). If a service emits
// a coingecko id that Mobula doesn't recognise we treat it as unpriced —
// the CG fallback at the chained-pricer level catches those cases.
func (p *MobulaPricer) PriceUSD(ctx context.Context, coingeckoID, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	if coingeckoID == "" {
		return 0, false
	}
	key := "slug:" + coingeckoID

	p.mu.Lock()
	if c, ok := p.cache[key]; ok && p.now().Before(c.expires) {
		p.mu.Unlock()
		return c.usd, c.gotPrice
	}
	p.mu.Unlock()

	q := url.Values{}
	q.Set("asset", coingeckoID)
	price, ok := p.fetchPrice(ctx, q)
	ttl := pricerTTL
	if !ok {
		ttl = pricerNegTTL
	}
	p.mu.Lock()
	p.cache[key] = cachedPrice{usd: price, expires: p.now().Add(ttl), gotPrice: ok}
	p.mu.Unlock()
	return price, ok
}

// PriceTokenUSD: contract-address lookup. Empirically covers ~95 % of
// the ERC-20s Relay routes on supported chains (audit, May 2026); the
// rest are freshly-minted memecoins not yet indexed.
func (p *MobulaPricer) PriceTokenUSD(ctx context.Context, chainID int64, address, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	slug, ok := chainSlugs[chainID]
	if !ok || slug.mobula == "" || address == "" {
		return 0, false
	}
	key := fmt.Sprintf("mob:%d:%s", chainID, strings.ToLower(address))

	p.mu.Lock()
	if c, ok := p.cache[key]; ok && p.now().Before(c.expires) {
		p.mu.Unlock()
		return c.usd, c.gotPrice
	}
	p.mu.Unlock()

	q := url.Values{}
	q.Set("asset", address)
	q.Set("blockchain", slug.mobula)
	price, priced := p.fetchPrice(ctx, q)
	ttl := pricerTTL
	if !priced {
		ttl = pricerNegTTL
	}
	p.mu.Lock()
	p.cache[key] = cachedPrice{usd: price, expires: p.now().Add(ttl), gotPrice: priced}
	p.mu.Unlock()
	return price, priced
}

func (p *MobulaPricer) fetchPrice(ctx context.Context, q url.Values) (float64, bool) {
	u := p.baseURL + "/market/data?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, false
	}
	req.Header.Set("Accept", "application/json")
	// Mobula auth is the raw key in the Authorization header — no Bearer prefix.
	req.Header.Set("Authorization", p.apiKey)

	resp, err := p.http.Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return 0, false
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, false
	}
	var out struct {
		Data struct {
			Price float64 `json:"price"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return 0, false
	}
	if out.Data.Price <= 0 {
		return 0, false
	}
	return out.Data.Price, true
}

// chainedPricer queries pricers in order; first one to return a price
// wins. Used so we get Mobula-first coverage with a CG fallback for any
// asset Mobula doesn't know about.
type chainedPricer struct {
	pricers []Pricer
}

func newChainedPricer(ps ...Pricer) *chainedPricer {
	return &chainedPricer{pricers: ps}
}

func (c *chainedPricer) PriceUSD(ctx context.Context, coingeckoID, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	for _, p := range c.pricers {
		if v, ok := p.PriceUSD(ctx, coingeckoID, symbol); ok {
			return v, true
		}
	}
	return 0, false
}

func (c *chainedPricer) PriceTokenUSD(ctx context.Context, chainID int64, address, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	for _, p := range c.pricers {
		if v, ok := p.PriceTokenUSD(ctx, chainID, address, symbol); ok {
			return v, true
		}
	}
	return 0, false
}

// buildPricer wires up the active pricer for the harness, with Mobula
// preferred when MOBULA_API_KEY is set, and CoinGecko always available
// as fallback. Logs to stdout so operators can see which path is hot.
func buildPricer() Pricer {
	cg := NewCoinGeckoPricer()
	if mob, ok := NewMobulaPricer(); ok {
		fmt.Println("[pricer] Mobula oracle ACTIVE (CoinGecko fallback wired)")
		return newChainedPricer(mob, cg)
	}
	fmt.Println("[pricer] MOBULA_API_KEY not set — using CoinGecko free tier only")
	return cg
}
