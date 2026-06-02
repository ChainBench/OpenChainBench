package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const simDuneChainsURL = "https://api.sim.dune.com/v1/evm/supported-chains"

type simDuneChain struct {
	Name    string   `json:"name"`
	ChainID int      `json:"chain_id"`
	Tags    []string `json:"tags"`
}

type simDuneResponse struct {
	Chains []simDuneChain `json:"chains"`
}

// fetchSimDune queries Sim by Dune's public supported-chains endpoint.
// EVM-only by design. Mainnets are tagged "mainnet"; everything else is
// treated as testnet/preview and filtered out unless IncludeTestnets is on.
func fetchSimDune(cfg *Config) ProviderResult {
	res := ProviderResult{Provider: "dune"}

	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", simDuneChainsURL, nil)
	req.Header.Set("Accept", "application/json")
	if cfg.SimDuneAPIKey != "" {
		req.Header.Set("X-Sim-Api-Key", cfg.SimDuneAPIKey)
	}

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

	var parsed simDuneResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}

	for _, c := range parsed.Chains {
		isMainnet := false
		for _, t := range c.Tags {
			if t == "mainnet" {
				isMainnet = true
				break
			}
		}
		if !isMainnet && !cfg.IncludeTestnets {
			continue
		}
		res.Networks = append(res.Networks, Network{
			ChainID: strconv.Itoa(c.ChainID),
			Slug:    c.Name,
			Name:    c.Name,
			Testnet: !isMainnet,
		})
	}

	return res
}
