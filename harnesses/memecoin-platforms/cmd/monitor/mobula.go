package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type MobulaTrade struct {
	Platform        string  `json:"platform"`
	PlatformFeesUSD float64 `json:"platformFeesUSD"`
	GasFeesUSD      float64 `json:"gasFeesUSD"`
	MEVFeesUSD      float64 `json:"mevFeesUSD"`
	TotalFeesUSD    float64 `json:"totalFeesUSD"`
	// Amount in native token; AmountUSD is what we use for fee %.
	AmountUSD float64 `json:"amountUSD"`
}

type mobulaTradesResp struct {
	Data []MobulaTrade `json:"data"`
}

func fetchTrades(client *http.Client, apiKey, mint string) ([]MobulaTrade, error) {
	url := fmt.Sprintf(
		"https://api.mobula.io/api/2/token/trades-enriched?address=%s&chainId=solana:solana&sortOrder=desc&limit=200",
		mint,
	)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mobula fetch: %w", err)
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("mobula %d: %s", resp.StatusCode, snip(b, 300))
	}

	var out mobulaTradesResp
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("mobula decode: %w", err)
	}
	return out.Data, nil
}
