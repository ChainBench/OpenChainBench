package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const geckoTerminalNetworksURL = "https://api.geckoterminal.com/api/v2/networks"

type gtNetwork struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Attributes struct {
		Name                       string `json:"name"`
		CoingeckoAssetPlatformID   string `json:"coingecko_asset_platform_id"`
	} `json:"attributes"`
}

type gtListResponse struct {
	Data  []gtNetwork    `json:"data"`
	Links struct{ Next string `json:"next"` } `json:"links"`
}

func fetchGeckoTerminal(_ *Config) ProviderResult {
	client := &http.Client{Timeout: 15 * time.Second}
	res := ProviderResult{Provider: "geckoterminal"}
	allNetworks := []Network{}

	for page := 1; page <= 10; page++ {
		url := geckoTerminalNetworksURL + "?page=" + strconv.Itoa(page)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Accept", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			res.Err = fmt.Sprintf("request_error: %v", err)
			return res
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != 200 {
			res.Err = fmt.Sprintf("status_%d", resp.StatusCode)
			return res
		}

		var parsed gtListResponse
		if err := json.Unmarshal(body, &parsed); err != nil {
			res.Err = fmt.Sprintf("parse_error: %v", err)
			return res
		}

		if len(parsed.Data) == 0 {
			break
		}

		for _, n := range parsed.Data {
			allNetworks = append(allNetworks, Network{
				ChainID: n.Attributes.CoingeckoAssetPlatformID,
				Slug:    n.ID,
				Name:    n.Attributes.Name,
				Testnet: false,
			})
		}

		if parsed.Links.Next == "" {
			break
		}
	}

	res.Networks = allNetworks
	return res
}
