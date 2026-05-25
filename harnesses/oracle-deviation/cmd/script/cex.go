package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Binance and Coinbase REST tickers. Both are simple GET endpoints
// with stable, well-documented JSON shapes — no auth, low cost.
//
//   Binance: 1200 weight/min/IP, ticker/price = 2 weight, single
//            symbol → 10 calls / 30 s = 20 weight/min, trivial.
//   Coinbase: 10 req/s public, 10 calls / 30 s = ~0.33 req/s, trivial.
//
// We do NOT use the multi-symbol Binance endpoint because Coinbase
// has no equivalent and the per-pair shape keeps the two pollers
// symmetrical (and the error paths simple).

const (
	binanceURL  = "https://api.binance.com/api/v3/ticker/price"
	coinbaseURL = "https://api.exchange.coinbase.com/products/%s/ticker"
)

type binancePrice struct {
	Symbol string `json:"symbol"`
	Price  string `json:"price"`
}

type coinbaseTicker struct {
	Price string `json:"price"`
	Time  string `json:"time"`
}

func runBinance(ctx context.Context, specs []PairSpec) {
	client := &http.Client{Timeout: httpTimeout}
	t := time.NewTicker(pollInterval)
	defer t.Stop()

	tick := func() {
		for _, s := range specs {
			pollCtx, cancel := context.WithTimeout(ctx, httpTimeout)
			price, err := fetchBinance(pollCtx, client, s.BinanceSymbol)
			cancel()
			if err != nil {
				oracleScrapeErrors.WithLabelValues(string(SourceBinance), string(s.Pair)).Inc()
				fmt.Printf("[binance/%s] err: %v\n", s.Pair, err)
				continue
			}
			recordPrice(SourceBinance, s.Pair, price)
		}
	}

	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

func fetchBinance(ctx context.Context, client *http.Client, symbol string) (float64, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", binanceURL+"?symbol="+symbol, nil)
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("http %d: %s", resp.StatusCode, string(body))
	}
	var p binancePrice
	if err := json.Unmarshal(body, &p); err != nil {
		return 0, fmt.Errorf("decode: %w", err)
	}
	v, err := strconv.ParseFloat(p.Price, 64)
	if err != nil {
		return 0, fmt.Errorf("parse price: %w", err)
	}
	return v, nil
}

func runCoinbase(ctx context.Context, specs []PairSpec) {
	client := &http.Client{Timeout: httpTimeout}
	t := time.NewTicker(pollInterval)
	defer t.Stop()

	tick := func() {
		for _, s := range specs {
			pollCtx, cancel := context.WithTimeout(ctx, httpTimeout)
			price, err := fetchCoinbase(pollCtx, client, s.CoinbaseProduct)
			cancel()
			if err != nil {
				oracleScrapeErrors.WithLabelValues(string(SourceCoinbase), string(s.Pair)).Inc()
				fmt.Printf("[coinbase/%s] err: %v\n", s.Pair, err)
				continue
			}
			recordPrice(SourceCoinbase, s.Pair, price)
		}
	}

	tick()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

func fetchCoinbase(ctx context.Context, client *http.Client, product string) (float64, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf(coinbaseURL, product), nil)
	// Coinbase requires a User-Agent; default Go agent gets 400 from
	// some POPs.
	req.Header.Set("User-Agent", "openchainbench-oracle-deviation/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("http %d: %s", resp.StatusCode, string(body))
	}
	var t coinbaseTicker
	if err := json.Unmarshal(body, &t); err != nil {
		return 0, fmt.Errorf("decode: %w", err)
	}
	v, err := strconv.ParseFloat(t.Price, 64)
	if err != nil {
		return 0, fmt.Errorf("parse price: %w", err)
	}
	return v, nil
}
