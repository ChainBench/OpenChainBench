package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const coinpaprikaContractsURL = "https://api.coinpaprika.com/v1/contracts"

// CoinPaprika's /v1/contracts returns a flat array of platform slugs in
// "{symbol}-{name}" form (e.g. "eth-ethereum", "trx-tron"). It is the closest
// thing they expose to a list of "chains supported for contract lookup".
func fetchCoinPaprika(_ *Config) ProviderResult {
	res := ProviderResult{Provider: "coinpaprika"}

	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", coinpaprikaContractsURL, nil)
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

	var parsed []string
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Err = fmt.Sprintf("parse_error: %v", err)
		return res
	}

	for _, slug := range parsed {
		name := slug
		if idx := strings.Index(slug, "-"); idx >= 0 && idx+1 < len(slug) {
			name = strings.ReplaceAll(slug[idx+1:], "-", " ")
		}
		res.Networks = append(res.Networks, Network{
			ChainID: "",
			Slug:    slug,
			Name:    name,
		})
	}

	return res
}
