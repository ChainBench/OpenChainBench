package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

func get(url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "OpenChainBench/1.0 perp-token-metrics")
	return httpClient.Do(req)
}

// fetchLlamaRevenue returns (rev24h, avg30dDaily, ok).
func fetchLlamaRevenue(slug string) (float64, float64, bool) {
	url := fmt.Sprintf("https://api.llama.fi/summary/fees/%s?dataType=dailyRevenue", slug)
	resp, err := get(url)
	if err != nil || resp.StatusCode != 200 {
		return 0, 0, false
	}
	defer resp.Body.Close()

	var d struct {
		Total24h       float64          `json:"total24h"`
		TotalDataChart [][2]json.Number `json:"totalDataChart"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return 0, 0, false
	}

	chart := d.TotalDataChart
	start := len(chart) - 30
	if start < 0 {
		start = 0
	}
	var sum float64
	var count int
	for _, pt := range chart[start:] {
		v, err := pt[1].Float64()
		if err != nil || v <= 0 {
			continue
		}
		sum += v
		count++
	}
	if count == 0 {
		return d.Total24h, 0, false
	}
	return d.Total24h, sum / float64(count), true
}

// fetchCGFdvBatch fetches FDV for multiple CoinGecko IDs in one request.
func fetchCGFdvBatch(ids []string) map[string]float64 {
	result := map[string]float64{}
	if len(ids) == 0 {
		return result
	}

	url := fmt.Sprintf(
		"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=%s&per_page=50&sparkline=false",
		strings.Join(ids, ","),
	)
	resp, err := get(url)
	if err != nil || resp.StatusCode != 200 {
		return result
	}
	defer resp.Body.Close()

	var coins []struct {
		ID                  string   `json:"id"`
		FullyDilutedVal     *float64 `json:"fully_diluted_valuation"`
		MarketCap           *float64 `json:"market_cap"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&coins); err != nil {
		return result
	}

	for _, c := range coins {
		fdv := c.FullyDilutedVal
		if fdv == nil {
			fdv = c.MarketCap
		}
		if fdv != nil && *fdv > 0 {
			result[c.ID] = *fdv
		}
	}
	return result
}
