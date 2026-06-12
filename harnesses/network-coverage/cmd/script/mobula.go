package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const mobulaBlockchainsURL = "https://api.mobula.io/api/1/blockchains"

type mobulaBlockchain struct {
	Name       string `json:"name"`
	ChainID    any    `json:"chainId"`    // can be number, string, or "solana"
	EVMChainID any    `json:"evmChainId"` // present (number) on EVM chains, absent elsewhere
	Slug       string `json:"slug"`
}

type mobulaListResponse struct {
	Data []mobulaBlockchain `json:"data"`
}

func fetchMobula(cfg *Config) ProviderResult {
	res := ProviderResult{Provider: "mobula"}
	if cfg.MobulaAPIKey == "" {
		res.Err = "missing_api_key"
		return res
	}

	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", mobulaBlockchainsURL, nil)
	req.Header.Set("Authorization", cfg.MobulaAPIKey)
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

	var parsed mobulaListResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}

	for _, b := range parsed.Data {
		res.Networks = append(res.Networks, Network{
			ChainID: fmt.Sprintf("%v", b.ChainID),
			Slug:    b.Slug,
			Name:    b.Name,
		})
	}

	return res
}
