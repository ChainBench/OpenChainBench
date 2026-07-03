package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Mobula has two endpoints we consume per chain:
//   1. /api/1/market/data?symbol=<NATIVE>      — native token price + mcap
//   2. /api/1/market/blockchain/stats?blockchain=<MOBULA_NAME>
//        — DEX liquidity + 24h volume + tokens-indexed-by-Mobula count
//
// The native-token endpoint is per-symbol so several OCB chains map to the
// same call (every L2 = ETH); we dedup before firing requests so the API
// only sees one /market/data per native symbol per tick.
//
// Authorization header takes a raw API key (no "Bearer" prefix, see
// mobula docs). Missing key = 429 immediately; the harness logs and
// keeps polling DefiLlama so the page still renders the DeFi cards.

const (
	mobulaBase  = "https://api.mobula.io"
	mobulaUA    = "OCB-chain-kpis/1.0"
)

var httpClientMobula = &http.Client{Timeout: 15 * time.Second}

func fetchAllMobula(cfg *Config) {
	if cfg.MobulaAPIKey == "" {
		fmt.Println("[mobula] MOBULA_API_KEY missing, skipping Mobula fetch")
		return
	}

	// Dedup native symbols. The 21 chains today flatten to 11 unique
	// natives (every L2 = ETH).
	natives := map[string][]Chain{}
	for _, c := range Registry {
		if c.NativeSymbol == "" {
			continue
		}
		natives[c.NativeSymbol] = append(natives[c.NativeSymbol], c)
	}
	for sym, chains := range natives {
		sym, chains := sym, chains
		go fetchMobulaNative(cfg, sym, chains)
	}

	// Chain-stats endpoint is per chain. Fire each as its own goroutine.
	for _, c := range Registry {
		c := c
		if c.Mobula == "" {
			continue
		}
		go fetchMobulaChainStats(cfg, c)
	}
}

// fetchMobulaNative pulls native price + mcap for one symbol and writes
// the value to every chain that uses this native (ETH → all rollups).
func fetchMobulaNative(cfg *Config, symbol string, chains []Chain) {
	start := time.Now()
	url := fmt.Sprintf("%s/api/1/market/data?symbol=%s", mobulaBase, encodePath(symbol))
	body, err := getJSONWithAuth(httpClientMobula, url, cfg.MobulaAPIKey)
	latency := float64(time.Since(start).Milliseconds())
	for _, c := range chains {
		chainKpisFetchLatencyMs.WithLabelValues(c.Slug, "mobula-native").Set(latency)
	}
	if err != nil {
		bucket := classifyError(err.Error())
		for _, c := range chains {
			chainKpisFetchErrors.WithLabelValues(c.Slug, "mobula-native", bucket).Inc()
		}
		fmt.Printf("[mobula-native][%s] error: %v\n", symbol, err)
		return
	}
	var resp struct {
		Data struct {
			Price     float64 `json:"price"`
			MarketCap float64 `json:"market_cap"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		for _, c := range chains {
			chainKpisFetchErrors.WithLabelValues(c.Slug, "mobula-native", "parse").Inc()
		}
		fmt.Printf("[mobula-native][%s] parse error: %v\n", symbol, err)
		return
	}
	for _, c := range chains {
		if resp.Data.Price > 0 {
			chainNativePriceUsd.WithLabelValues(c.Slug, symbol).Set(resp.Data.Price)
		}
		if resp.Data.MarketCap > 0 {
			chainNativeMcapUsd.WithLabelValues(c.Slug, symbol).Set(resp.Data.MarketCap)
		}
		chainKpisLastRefresh.WithLabelValues(c.Slug, "mobula-native").Set(float64(time.Now().Unix()))
	}
	chainKpisLastTickUnix.Set(float64(time.Now().Unix()))
}

// fetchMobulaChainStats pulls the blockchain-stats payload for one chain
// and writes the tokens-indexed gauge. We deliberately drop the volume
// and liquidity series here — the canonical DEX volume / TVL signal on
// the chain page comes from DefiLlama for consistency across chains
// (DefiLlama covers chains Mobula doesn't, and the public reads them as
// the standard reference). The Mobula "tokens indexed" gauge is the
// unique data we publish from this endpoint.
func fetchMobulaChainStats(cfg *Config, c Chain) {
	start := time.Now()
	url := fmt.Sprintf("%s/api/1/market/blockchain/stats?blockchain=%s", mobulaBase, encodePath(c.Mobula))
	body, err := getJSONWithAuth(httpClientMobula, url, cfg.MobulaAPIKey)
	chainKpisFetchLatencyMs.WithLabelValues(c.Slug, "mobula-stats").Set(float64(time.Since(start).Milliseconds()))
	if err != nil {
		chainKpisFetchErrors.WithLabelValues(c.Slug, "mobula-stats", classifyError(err.Error())).Inc()
		fmt.Printf("[mobula-stats][%s] error: %v\n", c.Slug, err)
		return
	}
	var resp struct {
		Data struct {
			TokensHistory [][]float64 `json:"tokens_history"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		chainKpisFetchErrors.WithLabelValues(c.Slug, "mobula-stats", "parse").Inc()
		fmt.Printf("[mobula-stats][%s] parse error: %v\n", c.Slug, err)
		return
	}
	if n := len(resp.Data.TokensHistory); n > 0 {
		last := resp.Data.TokensHistory[n-1]
		if len(last) >= 2 {
			chainMobulaTokensIndexed.WithLabelValues(c.Slug).Set(last[1])
		}
	}
	chainKpisLastRefresh.WithLabelValues(c.Slug, "mobula-stats").Set(float64(time.Now().Unix()))
}

// getJSONWithAuth is the auth-bearing variant of getJSON.
// Mobula expects the bare API key in the Authorization header (no Bearer
// prefix), per the docs and verified against the live API.
func getJSONWithAuth(client *http.Client, url, key string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", key)
	req.Header.Set("User-Agent", mobulaUA)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request_error: %w", err)
	}
	defer resp.Body.Close()
	body := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			body = append(body, buf[:n]...)
		}
		if err != nil {
			break
		}
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status_%d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}
