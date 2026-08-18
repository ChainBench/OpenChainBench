package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// BackpackNativeSource queries the Backpack Exchange public tickers endpoint
// and sums quoteVolume for all perpetual futures markets (symbols ending in
// _PERP) to derive the 24h rolling USD notional.
//
// Endpoint: GET https://api.backpack.exchange/api/v1/tickers
//
// Response: JSON array of ticker objects. Each ticker has:
//   - symbol      e.g. "BTC_USDC_PERP", "ETH_USDC_PERP"
//   - quoteVolume 24h notional in USDC (= USD)
//
// We filter for _PERP suffix and sum quoteVolume across all markets.
// Backpack is a hybrid exchange with CLOB execution on Solana, offering
// decentralized custody with CEX-grade performance.
type BackpackNativeSource struct {
	client *http.Client
}

func NewBackpackNativeSource() *BackpackNativeSource {
	return &BackpackNativeSource{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (s *BackpackNativeSource) Name() string { return srcBackpackNative }

type backpackTicker struct {
	Symbol      string  `json:"symbol"`
	QuoteVolume float64 `json:"quoteVolume,string"`
}

func (s *BackpackNativeSource) Fetch() (*SourceResult, error) {
	res := newSourceResult()
	venue := "backpack"

	body, err := s.get("https://api.backpack.exchange/api/v1/tickers")
	if err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcBackpackNative, classifyError(err.Error())).Inc()
		fmt.Printf("[perp-cohort][%s][%s] err: %v\n", venue, srcBackpackNative, err)
		return res, nil
	}

	var tickers []backpackTicker
	if err := json.Unmarshal(body, &tickers); err != nil {
		perpCohortFetchErrors.WithLabelValues(venue, srcBackpackNative, "parse").Inc()
		fmt.Printf("[perp-cohort][%s][%s] parse err: %v\n", venue, srcBackpackNative, err)
		return res, nil
	}

	var total float64
	var count int
	for _, t := range tickers {
		if strings.HasSuffix(t.Symbol, "_PERP") && t.QuoteVolume > 0 {
			total += t.QuoteVolume
			count++
		}
	}

	if total > 0 {
		res.SetIfPositive(venue, mVolume24h, total)
		fmt.Printf("[perp-cohort][%s][%s] ok: vol24h=%.0f USD across %d perp markets\n",
			venue, srcBackpackNative, total, count)
	}
	return res, nil
}

func (s *BackpackNativeSource) get(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "OpenChainBench-PerpCohort/1.0 contact@mobula.io")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		snippet := string(body)
		if len(snippet) > 100 {
			snippet = snippet[:100]
		}
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, snippet)
	}
	return body, nil
}
