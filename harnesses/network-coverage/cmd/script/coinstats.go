package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const coinstatsBlockchainsURL = "https://openapiv1.coinstats.app/wallet/blockchains"

// CoinStats /wallet/blockchains returns a flat JSON array of:
//   {connectionId, name, icon, chain}
// `connectionId` is the slug (e.g. "binancesmartchain"), `chain` is the
// category enum (e.g. "binance_smart"), `name` is the human label.
type coinstatsBlockchain struct {
	ConnectionID string `json:"connectionId"`
	Name         string `json:"name"`
	Chain        string `json:"chain"`
}

func fetchCoinStats(cfg *Config) ProviderResult {
	res := ProviderResult{Provider: "coinstats"}
	if cfg.CoinStatsAPIKey == "" {
		res.Err = "missing_api_key"
		return res
	}

	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", coinstatsBlockchainsURL, nil)
	req.Header.Set("X-API-KEY", cfg.CoinStatsAPIKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		res.Err = fmt.Sprintf("request_error: %v", err)
		return res
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		res.Err = fmt.Sprintf("status_%d", resp.StatusCode)
		return res
	}

	var arr []coinstatsBlockchain
	if err := json.Unmarshal(body, &arr); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}

	for _, b := range arr {
		res.Networks = append(res.Networks, Network{
			ChainID: b.Chain,
			Slug:    b.ConnectionID,
			Name:    b.Name,
		})
	}
	return res
}
