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
// We pull every native token through /market/multi-data every
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

// FetchPrices pulls USD prices for the given Mobula keys. Slugs go in one
// `assets=` call and all-digit asset ids in one `ids=` call; Mobula keys
// each answer by the string it was asked for, so the returned map is
// keyed exactly like the input. Missing keys are simply absent. A failure
// of one call does not drop the prices the other call returned.
func (m *MobulaClient) FetchPrices(keys []string) (map[string]float64, error) {
	slugs, ids := splitMobulaKeys(keys)
	prices := make(map[string]float64, len(keys))
	var firstErr error
	for _, q := range []struct {
		param string
		vals  []string
	}{{"assets", slugs}, {"ids", ids}} {
		if len(q.vals) == 0 {
			continue
		}
		got, err := m.fetchMulti(q.param, q.vals)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for k, v := range got {
			prices[k] = v
		}
	}
	if len(prices) == 0 && firstErr != nil {
		return nil, firstErr
	}
	if firstErr != nil {
		fmt.Printf("[PRICE] partial refresh: %v\n", firstErr)
	}
	return prices, nil
}

// isMobulaID reports whether a key is a numeric Mobula asset id.
func isMobulaID(k string) bool {
	if k == "" {
		return false
	}
	for _, r := range k {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func splitMobulaKeys(keys []string) (slugs, ids []string) {
	for _, k := range keys {
		if isMobulaID(k) {
			ids = append(ids, k)
		} else {
			slugs = append(slugs, k)
		}
	}
	return slugs, ids
}

func (m *MobulaClient) fetchMulti(param string, vals []string) (map[string]float64, error) {
	url := "https://api.mobula.io/api/1/market/multi-data?" + param + "=" + strings.Join(vals, ",")
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
