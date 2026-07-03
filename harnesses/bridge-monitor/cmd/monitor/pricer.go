package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

// pricer fetches and caches USD spot prices for tokens we benchmark in non-stable
// quantities (currently just TRUMP for R4). Avoids the previous footgun where a
// hardcoded $2.87/TRUMP made our $300-labelled quotes actually send $266 worth,
// reporting bogus $33 of "slippage".

var (
	priceMu    sync.RWMutex
	priceCache = map[string]priceEntry{}
	priceHTTP  = &http.Client{Timeout: 10 * time.Second}
)

type priceEntry struct {
	value     float64
	fetchedAt time.Time
}

// 5min TTL: Mobula market data is fast, no point hitting it harder than the quote loop.
const priceTTL = 5 * time.Minute

// TokenPriceUSD returns the cached USD price for a symbol. On miss or staleness
// it fetches from Mobula. Returns `fallback` if the fetch fails (network, parse
// error, zero price) so the monitor never blocks on price discovery.
func TokenPriceUSD(symbol string, fallback float64) float64 {
	priceMu.RLock()
	if e, ok := priceCache[symbol]; ok && time.Since(e.fetchedAt) < priceTTL {
		priceMu.RUnlock()
		return e.value
	}
	priceMu.RUnlock()

	p := fetchPriceUSD(symbol)
	if p <= 0 {
		return fallback
	}
	priceMu.Lock()
	priceCache[symbol] = priceEntry{value: p, fetchedAt: time.Now()}
	priceMu.Unlock()
	return p
}

func fetchPriceUSD(symbol string) float64 {
	apiKey := os.Getenv("MOBULA_API_KEY")
	url := fmt.Sprintf("https://api.mobula.io/api/1/market/data?symbol=%s", symbol)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return 0
	}
	if apiKey != "" {
		req.Header.Set("Authorization", apiKey)
	}
	resp, err := priceHTTP.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var r struct {
		Data struct {
			Price float64 `json:"price"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return 0
	}
	return r.Data.Price
}
