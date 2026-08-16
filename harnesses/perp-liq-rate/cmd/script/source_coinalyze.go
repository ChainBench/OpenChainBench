package main

// source_coinalyze.go — shared Coinalyze client (Lighter + Hyperliquid).
//
// Key fix: buckets are converted to USD using the hourly close price of *that
// specific bucket* (HL candleSnapshot, free, no key), not the current mark
// price. This removes the directional bias on crash days where liquidations of
// longs at 09:00 converted at the 23:00 price were systematically under-valued.

import (
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"
)

const czBaseURLConst = "https://api.coinalyze.net/v1"
const hlCandleSnapshotURL = "https://api.hyperliquid.xyz/info"

// czBucket is one hourly bucket from Coinalyze /liquidation-history.
type czBucket struct {
	T int64   // bucket start, unix seconds
	L float64 // long liquidations, base-asset units
	S float64 // short liquidations, base-asset units
}

// czClient wraps the Coinalyze API key and base URL.
type czClient struct {
	apiKey  string
	baseURL string
}

// fetchLiqBuckets returns hourly liquidation buckets for the given Coinalyze
// symbol over [fromSec, toSec].
func (c *czClient) fetchLiqBuckets(symbol string, fromSec, toSec int64) ([]czBucket, error) {
	u := fmt.Sprintf("%s/liquidation-history?symbols=%s&interval=1hour&from=%d&to=%d&api_key=%s",
		c.baseURL, url.QueryEscape(symbol), fromSec, toSec, c.apiKey)
	var resp []struct {
		History []struct {
			T int64   `json:"t"`
			L float64 `json:"l"`
			S float64 `json:"s"`
		} `json:"history"`
	}
	if err := httpGetJSON(u, &resp); err != nil {
		return nil, fmt.Errorf("coinalyze liquidation-history %s: %w", symbol, err)
	}
	var out []czBucket
	for _, r := range resp {
		for _, h := range r.History {
			out = append(out, czBucket{T: h.T, L: h.L, S: h.S})
		}
	}
	return out, nil
}

// czDiscoverSymbol queries /future-markets and finds the symbol for a given
// exchange (partial name match) and base asset. Used once at startup to
// resolve Hyperliquid's symbol codes without hardcoding the exchange ID.
func (c *czClient) czDiscoverSymbol(exchangeSlug, asset string) (string, error) {
	u := fmt.Sprintf("%s/future-markets?api_key=%s", c.baseURL, c.apiKey)
	var markets []struct {
		Symbol    string `json:"symbol"`
		Exchange  string `json:"exchange"`
		BaseAsset string `json:"base_asset"`
	}
	if err := httpGetJSON(u, &markets); err != nil {
		return "", fmt.Errorf("coinalyze future-markets: %w", err)
	}
	slug := strings.ToLower(exchangeSlug)
	assetUpper := strings.ToUpper(asset)
	for _, m := range markets {
		if !strings.Contains(strings.ToLower(m.Exchange), slug) {
			continue
		}
		if strings.ToUpper(m.BaseAsset) == assetUpper {
			return m.Symbol, nil
		}
	}
	return "", fmt.Errorf("coinalyze: no symbol found for exchange %q asset %q", exchangeSlug, asset)
}

// hlCandle is one candle from Hyperliquid candleSnapshot.
type hlCandle struct {
	T int64  `json:"t"` // open time ms
	C string `json:"c"` // close price
}

// fetchHourlyCloses returns hourly close prices from a HL-compatible candleSnapshot endpoint.
// infoURL defaults to hlCandleSnapshotURL. Tests pass a local server URL.
// Returns map[bucket_start_unix_sec -> close_price_usd]. Free, no API key.
func fetchHourlyCloses(coin string, fromMs, toMs int64, infoURL string) (map[int64]float64, error) {
	if infoURL == "" {
		infoURL = hlCandleSnapshotURL
	}
	payload := map[string]any{
		"type": "candleSnapshot",
		"req": map[string]any{
			"coin":      coin,
			"interval":  "1h",
			"startTime": fromMs,
			"endTime":   toMs,
		},
	}
	var candles []hlCandle
	if err := httpPostJSON(infoURL, payload, &candles); err != nil {
		return nil, fmt.Errorf("hl candleSnapshot %s: %w", coin, err)
	}
	out := make(map[int64]float64, len(candles))
	for _, c := range candles {
		px, err := parseF(c.C)
		if err != nil || px == 0 {
			continue
		}
		// Align to 1h boundary (bucket start).
		sec := c.T / 1000
		sec = sec - (sec % 3600)
		out[sec] = px
	}
	return out, nil
}

// bucketsToEvents converts Coinalyze buckets → LiqEvents using per-bucket close prices.
// Falls back to fallbackPx when a bucket has no corresponding candle.
func bucketsToEvents(keyPrefix, assetName string, buckets []czBucket, priceMap map[int64]float64, fallbackPx float64, sinceMs int64) []LiqEvent {
	var events []LiqEvent
	for _, b := range buckets {
		tsMs := b.T * 1000
		if tsMs < sinceMs {
			continue
		}
		total := b.L + b.S
		if total == 0 {
			continue
		}
		px, ok := priceMap[b.T]
		if !ok || px == 0 {
			px = fallbackPx
		}
		if px == 0 {
			continue
		}
		events = append(events, LiqEvent{
			Key:         fmt.Sprintf("%s:%s:%d", keyPrefix, assetName, b.T),
			NotionalUSD: total * px,
			TimestampMs: tsMs,
		})
	}
	return events
}

// fetchRealizedVol24h computes 24h realized volatility (%) from hourly HL closes.
// Formula: sqrt(sum of squared log-returns over 24h) × 100.
// Returns 0 with no error when not enough candles are available.
func fetchRealizedVol24h(coin string) (float64, error) {
	now := time.Now()
	fromMs := now.Add(-25 * time.Hour).UnixMilli()
	toMs := now.UnixMilli()
	prices, err := fetchHourlyCloses(coin, fromMs, toMs, "")
	if err != nil {
		return 0, fmt.Errorf("realized vol %s: %w", coin, err)
	}
	if len(prices) < 2 {
		return 0, nil
	}

	type kv struct{ sec int64; px float64 }
	sorted := make([]kv, 0, len(prices))
	for sec, px := range prices {
		sorted = append(sorted, kv{sec, px})
	}
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j-1].sec > sorted[j].sec; j-- {
			sorted[j-1], sorted[j] = sorted[j], sorted[j-1]
		}
	}

	sumSq := 0.0
	count := 0
	for i := 1; i < len(sorted); i++ {
		if sorted[i-1].px <= 0 || sorted[i].px <= 0 {
			continue
		}
		lr := math.Log(sorted[i].px / sorted[i-1].px)
		sumSq += lr * lr
		count++
	}
	if count == 0 {
		return 0, nil
	}
	return math.Sqrt(sumSq) * 100, nil
}
