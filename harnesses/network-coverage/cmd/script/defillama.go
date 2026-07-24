package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefiLlama tracks TVL across every chain with at least one indexed
// protocol. Broader than "DEX-only" (includes lending, LSTs, restaking,
// bridges, oracles), but it is the canonical open reference for
// "chains with meaningful on-chain financial activity" — and the same
// crawler backs their DEX-volumes aggregator, so DEX chains are a
// subset of what /chains returns.
const defiLlamaChainsURL = "https://api.llama.fi/chains"

type defiLlamaChain struct {
	Name     string  `json:"name"`
	ChainID  any     `json:"chainId"`  // number for EVM chains, null elsewhere
	Gecko    string  `json:"gecko_id"`
	TVL      float64 `json:"tvl"`
	CMCID    string  `json:"cmcId"`
	TokenSym string  `json:"tokenSymbol"`
}

func fetchDefiLlama(_ *Config) ProviderResult {
	res := ProviderResult{Provider: "defillama"}
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", defiLlamaChainsURL, nil)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/1.0 (+https://openchainbench.com)")

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

	var parsed []defiLlamaChain
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}
	for _, c := range parsed {
		res.Networks = append(res.Networks, Network{
			ChainID: fmt.Sprintf("%v", c.ChainID),
			Slug:    c.Gecko,
			Name:    c.Name,
		})
	}
	return res
}
