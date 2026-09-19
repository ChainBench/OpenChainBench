package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MobulaClient fetches USD prices from Mobula's public market API.
//
// We pull all 11 native tokens in one /market/multi-data call every
// PriceRefresh (30s) and cache them. Each chain fetcher reads the cached
// price at sample emit time.
type MobulaClient struct {
	apiKey string
	http   *http.Client
}

func NewMobulaClient(apiKey string) *MobulaClient {
	return &MobulaClient{
		apiKey: apiKey,
		http:   &http.Client{Timeout: 8 * time.Second},
	}
}

type multiDataResp struct {
	Data map[string]struct {
		Price float64 `json:"price"`
	} `json:"data"`
}

// FetchPrices pulls USD prices for the given Mobula slugs in one call.
// Returns map[slug]price. Missing slugs are simply absent from the map.
func (m *MobulaClient) FetchPrices(slugs []string) (map[string]float64, error) {
	url := "https://api.mobula.io/api/1/market/multi-data?assets=" + strings.Join(slugs, ",")
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	if m.apiKey != "" {
		req.Header.Set("Authorization", m.apiKey)
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("mobula http %d: %s", resp.StatusCode, string(body[:min(len(body), 200)]))
	}
	var out multiDataResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	prices := make(map[string]float64, len(out.Data))
	for slug, v := range out.Data {
		if v.Price > 0 {
			prices[slug] = v.Price
		}
	}
	return prices, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
