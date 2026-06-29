package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// AlchemyContractMetadataResponse is the v3 NFT API contract endpoint shape.
// All five scored fields live under `openSeaMetadata` except `name` which is
// at top level. floorPrice is a JSON number (not a string like Moralis).
type AlchemyContractMetadataResponse struct {
	Name            string `json:"name"`
	OpenSeaMetadata struct {
		ImageURL    string  `json:"imageUrl"`
		Description string  `json:"description"`
		FloorPrice  float64 `json:"floorPrice"`
		ExternalURL string  `json:"externalUrl"`
	} `json:"openSeaMetadata"`
}

var alchemyClient = &http.Client{Timeout: 10 * time.Second}

func checkAlchemy(coll NFTCollection, apiKey, region string) NFTResult {
	res := newResult("alchemy", coll.Name)

	if apiKey == "" {
		res.Error = "missing_api_key"
		res.ErrorType = "config"
		recordError("alchemy", region, "config")
		return res
	}

	url := fmt.Sprintf("https://eth-mainnet.g.alchemy.com/nft/v3/%s/getContractMetadata?contractAddress=%s", apiKey, coll.Contract)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		res.Error = err.Error()
		res.ErrorType = "request_error"
		recordError("alchemy", region, "request_error")
		return res
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	start := time.Now()
	resp, err := alchemyClient.Do(req)
	res.LatencyMs = float64(time.Since(start).Milliseconds())
	recordLatency("alchemy", region, res.LatencyMs)

	if err != nil {
		res.Error = err.Error()
		res.ErrorType = classifyNetError(err)
		recordError("alchemy", region, res.ErrorType)
		return res
	}
	defer resp.Body.Close()
	res.StatusCode = resp.StatusCode

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		res.Error = fmt.Sprintf("status_%d", resp.StatusCode)
		res.ErrorType = classifyHTTPStatus(resp.StatusCode)
		recordError("alchemy", region, res.ErrorType)
		return res
	}

	var parsed AlchemyContractMetadataResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Error = "parse_error: " + err.Error()
		res.ErrorType = "parse_error"
		recordError("alchemy", region, "parse_error")
		return res
	}

	res.Fields["name"] = strNonEmpty(parsed.Name)
	res.Fields["image"] = strNonEmpty(parsed.OpenSeaMetadata.ImageURL)
	res.Fields["description"] = strNonEmpty(parsed.OpenSeaMetadata.Description)
	res.Fields["floor_eth"] = numPositive(parsed.OpenSeaMetadata.FloorPrice)
	res.Fields["external_url"] = strNonEmpty(parsed.OpenSeaMetadata.ExternalURL)
	res.Values["floor_eth"] = fmt.Sprintf("%g", parsed.OpenSeaMetadata.FloorPrice)
	return res
}
