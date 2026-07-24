package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DexPaprika is CoinPaprika's dedicated DEX tracker product (separate
// from the main CoinPaprika asset-registry API). /networks returns the
// chains where they actively index DEX pools + trade volumes, which is
// what the reader coming from a "which DEX aggregator supports the most
// chains" search actually wants.
const dexPaprikaNetworksURL = "https://api.dexpaprika.com/networks"

type dexpaprikaNetwork struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

func fetchDexPaprika(_ *Config) ProviderResult {
	res := ProviderResult{Provider: "dexpaprika"}
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", dexPaprikaNetworksURL, nil)
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

	var parsed []dexpaprikaNetwork
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}
	for _, n := range parsed {
		res.Networks = append(res.Networks, Network{
			ChainID: "",
			Slug:    n.ID,
			Name:    n.DisplayName,
		})
	}
	return res
}
