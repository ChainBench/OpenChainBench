package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type PumpToken struct {
	Mint   string  `json:"mint"`
	Symbol string  `json:"symbol"`
	Name   string  `json:"name"`
	MCap   float64 `json:"market_cap"`
}

func fetchTopTokens(client *http.Client, limit int) ([]PumpToken, error) {
	url := fmt.Sprintf(
		"https://frontend-api-v3.pump.fun/coins?sort=market_cap&order=DESC&limit=%d&includeNsfw=false",
		limit,
	)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; OCBBot/1.0)")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("pump.fun fetch: %w", err)
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("pump.fun %d: %s", resp.StatusCode, snip(b, 200))
	}

	var tokens []PumpToken
	if err := json.Unmarshal(b, &tokens); err != nil {
		return nil, fmt.Errorf("pump.fun decode: %w", err)
	}
	return tokens, nil
}

func snip(b []byte, n int) string {
	if len(b) > n {
		return string(b[:n])
	}
	return string(b)
}
