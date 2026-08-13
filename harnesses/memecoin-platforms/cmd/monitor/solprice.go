package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"
	"math"
)

const coingeckoURL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"

// solPriceBits stores the current SOL/USD price as a uint64 (math.Float64bits).
var solPriceBits atomic.Uint64

func init() {
	setSolPrice(150.0)
}

func setSolPrice(usd float64) {
	solPriceBits.Store(math.Float64bits(usd))
}

func getSolPrice() float64 {
	return math.Float64frombits(solPriceBits.Load())
}

func updateSolPrice(client *http.Client) {
	price, err := fetchSolPrice(client)
	if err != nil {
		fmt.Printf("[solprice] fetch failed: %v (keeping %.2f)\n", err, getSolPrice())
		return
	}
	setSolPrice(price)
	fmt.Printf("[solprice] updated: $%.2f\n", price)
}

func fetchSolPrice(client *http.Client) (float64, error) {
	req, err := http.NewRequest(http.MethodGet, coingeckoURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("coingecko: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return 0, fmt.Errorf("read: %w", err)
	}
	if resp.StatusCode >= 400 {
		return 0, fmt.Errorf("status %d: %.100s", resp.StatusCode, body)
	}

	var out struct {
		Solana struct {
			USD float64 `json:"usd"`
		} `json:"solana"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if out.Solana.USD <= 0 {
		return 0, fmt.Errorf("invalid price: %v", out.Solana.USD)
	}
	return out.Solana.USD, nil
}

func startSolPriceRefresher(interval time.Duration) {
	client := &http.Client{Timeout: 10 * time.Second}
	updateSolPrice(client)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			updateSolPrice(client)
		}
	}()
}
