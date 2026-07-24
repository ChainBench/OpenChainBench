package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// CoinGecko exposes an authoritative list of every "asset platform" it
// knows about — i.e. every chain where it can look up token metadata by
// contract address. Public no-key endpoint; the free-tier rate limit
// (~30 req/min) is not a concern at a 6h sweep cadence.
const coinGeckoAssetPlatformsURL = "https://api.coingecko.com/api/v3/asset_platforms"

type coingeckoPlatform struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Shortname       string `json:"shortname"`
	ChainIdentifier any    `json:"chain_identifier"` // number for EVM chains, null elsewhere
}

func fetchCoinGecko(_ *Config) ProviderResult {
	res := ProviderResult{Provider: "coingecko"}
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", coinGeckoAssetPlatformsURL, nil)
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

	var parsed []coingeckoPlatform
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}

	for _, p := range parsed {
		res.Networks = append(res.Networks, Network{
			ChainID: fmt.Sprintf("%v", p.ChainIdentifier),
			Slug:    p.ID,
			Name:    p.Name,
		})
	}
	return res
}
