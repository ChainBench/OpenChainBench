package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const covalentChainsURL = "https://api.covalenthq.com/v1/chains/"

// Covalent returns chain_id as a numeric string even for canonical EVM
// chains (e.g. "1" for Ethereum). Keep the raw string to avoid losing
// precision on non-EVM chains where the id can exceed int64 range.
type covalentChain struct {
	ChainID   string `json:"chain_id"`
	Name      string `json:"name"`
	Label     string `json:"label"`
	IsTestnet bool   `json:"is_testnet"`
}

type covalentResponse struct {
	Data struct {
		Items []covalentChain `json:"items"`
	} `json:"data"`
	Error        bool   `json:"error"`
	ErrorMessage string `json:"error_message"`
}

func fetchCovalent(cfg *Config) ProviderResult {
	res := ProviderResult{Provider: "covalent"}
	if cfg.CovalentAPIKey == "" {
		res.Err = "missing_api_key"
		return res
	}

	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", covalentChainsURL, nil)
	req.Header.Set("Authorization", "Bearer "+cfg.CovalentAPIKey)
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

	var parsed covalentResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}
	if parsed.Error {
		res.Err = "api_error: " + parsed.ErrorMessage
		return res
	}

	for _, c := range parsed.Data.Items {
		if c.IsTestnet && !cfg.IncludeTestnets {
			continue
		}
		label := c.Label
		if label == "" {
			label = c.Name
		}
		res.Networks = append(res.Networks, Network{
			ChainID: c.ChainID,
			Slug:    c.Name,
			Name:    label,
			Testnet: c.IsTestnet,
		})
	}

	return res
}
