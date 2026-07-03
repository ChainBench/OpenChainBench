package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// pricer.go — USD spot prices. Two lookup axes:
//   1. by CoinGecko slug ("ethereum", "solana", …) for natives + listed assets
//   2. by (chainId, contract address) for any ERC-20 / SPL token
// Both axes route through a small in-process TTL cache to keep us off
// the free-tier rate limit on a 1/min poll cadence.
//
// USDC and other dollar pegs short-circuit to $1 to avoid burning a
// price call on every appFee.

const (
	pricerTTL        = 60 * time.Second
	pricerNegTTL     = 5 * time.Second // failed lookups cache briefly so we don't poison the price-path on a transient 429
	coinGeckoBaseURL = "https://api.coingecko.com/api/v3"
	pricerHTTPTO     = 8 * time.Second
)

// stablePegs are symbols we treat as exactly $1 — no upstream call.
// Includes bridged variants (USDC.E on Polygon, USDbC on Base) and the
// less-liquid pegs Relay sometimes routes (USDe, GHO, FRAX). Symbol
// match is case-insensitive (we uppercase before lookup).
var stablePegs = map[string]bool{
	// Major
	"USDC":  true,
	"USDT":  true,
	"DAI":   true,
	"FDUSD": true,
	"PYUSD": true,
	// Bridged USDC variants — Relay returns these as separate symbols
	// from the chain's native USDC, so a strict equality match drops
	// them. USDC.E (Polygon bridged) alone accounts for ~27 % of the
	// audited drop population.
	"USDC.E": true,
	"USDC.e": true,
	"USDBC":  true,
	"USDB":   true,
	// USD-pegged non-Circle stables observed in the swap stream.
	"USDE":  true, // Ethena
	"SUSDE": true, // staked Ethena
	"FRAX":  true,
	"GHO":   true,
	"USDP":  true,
	"TUSD":  true,
	"LUSD":  true,
	"USDD":  true,
	"USDS":  true,
	"MUSD":  true, // MetaMask USD on Linea
}

// chainSlug carries the per-source chain identifier each upstream
// pricer needs to scope a token-address lookup. Mobula and CoinGecko
// use different slug vocabularies even when they index the same chain.
type chainSlug struct {
	mobula     string // for /market/data?asset=<addr>&blockchain=<slug>
	coingecko  string // for /simple/token_price/{platform}/?contract_addresses=...
}

// chainSlugs maps Relay's numeric chainId to the slug each upstream
// pricer expects. Keep in sync with chains.go (the native-pricing map);
// adding a chain here only enables ERC-20 lookup, gas still needs an
// entry in chains.go to price the native.
//
// Slug verification (probed against live Mobula API):
//   - Optimism: Mobula uses "Optimistic" (titlecase) — confirmed via probe.
//   - Ronin, Soneium, Monad mainnet: HTTP 400 "Invalid blockchain" — omit.
//   - Bitcoin: no concept of ERC-20-style contracts; omit (gas-only).
var chainSlugs = map[int64]chainSlug{
	1:         {mobula: "ethereum", coingecko: "ethereum"},
	10:        {mobula: "Optimistic", coingecko: "optimistic-ethereum"},
	56:        {mobula: "BNB Smart Chain (BEP20)", coingecko: "binance-smart-chain"},
	130:       {mobula: "unichain", coingecko: "unichain"},
	137:       {mobula: "polygon", coingecko: "polygon-pos"},
	288:       {mobula: "boba", coingecko: "boba"},
	324:       {mobula: "zksync", coingecko: "zksync"},
	480:       {mobula: "worldchain", coingecko: "world-chain"},
	1088:      {mobula: "metis", coingecko: "metis-andromeda"},
	1101:      {mobula: "polygon-zkevm", coingecko: "polygon-zkevm"},
	1135:      {mobula: "lisk", coingecko: "lisk"},
	1329:      {mobula: "sei-evm", coingecko: "sei-network"},
	5000:      {mobula: "mantle", coingecko: "mantle"},
	7777777:   {mobula: "zora", coingecko: "zora-network"},
	8333:      {mobula: "b3", coingecko: "b3"},
	8453:      {mobula: "base", coingecko: "base"},
	33139:     {mobula: "apechain", coingecko: "apechain"},
	34443:     {mobula: "mode", coingecko: "mode"},
	42161:     {mobula: "arbitrum", coingecko: "arbitrum-one"},
	43114:     {mobula: "avalanche", coingecko: "avalanche"},
	57073:     {mobula: "ink", coingecko: "ink"},
	59144:     {mobula: "linea", coingecko: "linea"},
	60808:     {mobula: "bob", coingecko: "bob-network"},
	80094:     {mobula: "berachain", coingecko: "berachain"},
	81457:     {mobula: "blast", coingecko: "blast"},
	534352:    {mobula: "scroll", coingecko: "scroll"},
	666666666: {mobula: "degen", coingecko: "degen"},
	792703809: {mobula: "solana", coingecko: "solana"},
	// Abstract, Plume, TRON token-address slugs (gas-only support if
	// the slug rejects 400; harness still prices natives via PriceUSD).
	2741:      {mobula: "abstract", coingecko: "abstract"},
	98866:     {mobula: "plume", coingecko: "plume-network"},
	728126428: {mobula: "tron", coingecko: "tron"},
	25:        {mobula: "cronos", coingecko: "cronos"},
	143:       {mobula: "monad", coingecko: "monad"},
	360:       {mobula: "shape", coingecko: "shape"},
	48900:     {mobula: "zircuit", coingecko: "zircuit"},
	42018:     {mobula: "mythos", coingecko: ""}, // CG doesn't list a Mythos platform; Mobula only
	747474:    {mobula: "katana", coingecko: "katana"},
	685689:    {mobula: "gensyn", coingecko: ""},
}

// Pricer is the public interface. Two lookup methods:
//   PriceUSD: by canonical slug (CG id) + optional symbol fallback.
//   PriceTokenUSD: by (chainId, contract address) — required for ERC-20s
//   that don't have a CG slug or aren't on the stable allowlist.
type Pricer interface {
	PriceUSD(ctx context.Context, coingeckoID, symbol string) (float64, bool)
	PriceTokenUSD(ctx context.Context, chainID int64, address, symbol string) (float64, bool)
}

// cachedPrice is a single entry in the in-mem cache.
type cachedPrice struct {
	usd      float64
	expires  time.Time
	gotPrice bool
}

// CoinGeckoPricer is the fallback implementation. Two endpoints used:
//   - /simple/price?ids=<slug>           for native + listed assets
//   - /simple/token_price/{platform}?... for ERC-20 by contract address
type CoinGeckoPricer struct {
	baseURL string
	http    *http.Client
	mu      sync.Mutex
	cache   map[string]cachedPrice
	now     func() time.Time
}

func NewCoinGeckoPricer() *CoinGeckoPricer {
	return &CoinGeckoPricer{
		baseURL: coinGeckoBaseURL,
		http:    &http.Client{Timeout: pricerHTTPTO},
		cache:   map[string]cachedPrice{},
		now:     time.Now,
	}
}

// PriceUSD: stable symbol short-circuit → cache → upstream.
func (p *CoinGeckoPricer) PriceUSD(ctx context.Context, coingeckoID, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	if coingeckoID == "" {
		return 0, false
	}

	p.mu.Lock()
	if c, ok := p.cache[coingeckoID]; ok && p.now().Before(c.expires) {
		p.mu.Unlock()
		return c.usd, c.gotPrice
	}
	p.mu.Unlock()

	price, ok := p.fetchOne(ctx, coingeckoID)
	p.mu.Lock()
	ttl := pricerTTL
	if !ok {
		ttl = pricerNegTTL
	}
	p.cache[coingeckoID] = cachedPrice{usd: price, expires: p.now().Add(ttl), gotPrice: ok}
	p.mu.Unlock()
	return price, ok
}

// PriceTokenUSD: stable symbol short-circuit → (chainId, address) cache →
// /simple/token_price/{platform} upstream. Unknown chains return false.
func (p *CoinGeckoPricer) PriceTokenUSD(ctx context.Context, chainID int64, address, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	slug, ok := chainSlugs[chainID]
	if !ok || slug.coingecko == "" || address == "" {
		return 0, false
	}
	key := fmt.Sprintf("cg:%d:%s", chainID, strings.ToLower(address))

	p.mu.Lock()
	if c, ok := p.cache[key]; ok && p.now().Before(c.expires) {
		p.mu.Unlock()
		return c.usd, c.gotPrice
	}
	p.mu.Unlock()

	price, priced := p.fetchToken(ctx, slug.coingecko, address)
	ttl := pricerTTL
	if !priced {
		ttl = pricerNegTTL
	}
	p.mu.Lock()
	p.cache[key] = cachedPrice{usd: price, expires: p.now().Add(ttl), gotPrice: priced}
	p.mu.Unlock()
	return price, priced
}

func (p *CoinGeckoPricer) fetchOne(ctx context.Context, id string) (float64, bool) {
	q := url.Values{}
	q.Set("ids", id)
	q.Set("vs_currencies", "usd")
	u := p.baseURL + "/simple/price?" + q.Encode()

	body, ok := p.doJSON(ctx, u)
	if !ok {
		return 0, false
	}
	out := map[string]map[string]float64{}
	if err := json.Unmarshal(body, &out); err != nil {
		return 0, false
	}
	row, ok := out[id]
	if !ok {
		return 0, false
	}
	usd, ok := row["usd"]
	if !ok || usd <= 0 {
		return 0, false
	}
	return usd, true
}

func (p *CoinGeckoPricer) fetchToken(ctx context.Context, platform, address string) (float64, bool) {
	q := url.Values{}
	q.Set("contract_addresses", address)
	q.Set("vs_currencies", "usd")
	u := p.baseURL + "/simple/token_price/" + platform + "?" + q.Encode()

	body, ok := p.doJSON(ctx, u)
	if !ok {
		return 0, false
	}
	out := map[string]map[string]float64{}
	if err := json.Unmarshal(body, &out); err != nil {
		return 0, false
	}
	// CG lowercases the address in the response key.
	row, ok := out[strings.ToLower(address)]
	if !ok {
		return 0, false
	}
	usd, ok := row["usd"]
	if !ok || usd <= 0 {
		return 0, false
	}
	return usd, true
}

func (p *CoinGeckoPricer) doJSON(ctx context.Context, u string) ([]byte, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mobula-openchainbench/relay-revenue (contact@mobula.io)")

	resp, err := p.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, false
	}
	return body, true
}

// staticPricer is a deterministic in-memory pricer used in tests so we
// never hit the network. Lookup is exact-match on coingeckoID first,
// then fallback to upper-cased symbol. PriceTokenUSD uses a separate
// (chainId, address) map authored by the test.
type staticPricer struct {
	prices map[string]float64
	tokens map[string]float64 // "chainId:lowerAddress" → price
}

func newStaticPricer(prices map[string]float64) *staticPricer {
	cp := map[string]float64{}
	for k, v := range prices {
		cp[k] = v
	}
	return &staticPricer{prices: cp, tokens: map[string]float64{}}
}

// addToken seeds a (chainId, address) price for the test pricer.
func (s *staticPricer) addToken(chainID int64, address string, price float64) {
	s.tokens[fmt.Sprintf("%d:%s", chainID, strings.ToLower(address))] = price
}

func (s *staticPricer) PriceUSD(_ context.Context, coingeckoID, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	if coingeckoID != "" {
		if v, ok := s.prices[coingeckoID]; ok {
			return v, true
		}
	}
	if symbol != "" {
		if v, ok := s.prices[strings.ToUpper(symbol)]; ok {
			return v, true
		}
	}
	return 0, false
}

func (s *staticPricer) PriceTokenUSD(_ context.Context, chainID int64, address, symbol string) (float64, bool) {
	if symbol != "" && stablePegs[strings.ToUpper(symbol)] {
		return 1.0, true
	}
	if v, ok := s.tokens[fmt.Sprintf("%d:%s", chainID, strings.ToLower(address))]; ok {
		return v, true
	}
	return 0, false
}
