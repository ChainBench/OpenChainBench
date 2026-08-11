package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type MobulaTrade struct {
	Platform  string  `json:"platform"`
	Hash      string  `json:"hash"`
	Sender    string  `json:"sender"`
	AmountUSD float64 `json:"amountUSD"`
}

type mobulaTradesResp struct {
	Data []MobulaTrade `json:"data"`
}

func fetchTrades(client *http.Client, apiKey, mint string) ([]MobulaTrade, error) {
	from := time.Now().Add(-4 * time.Hour).UnixMilli()
	url := fmt.Sprintf(
		"https://api.mobula.io/api/2/token/trades-enriched?address=%s&chainId=solana:solana&sortOrder=desc&limit=100&from=%d",
		mint, from,
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
