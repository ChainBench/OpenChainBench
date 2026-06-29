package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// RaribleCollectionResponse: GET /v0.1/collections/ETHEREUM:{contract}.
// 4 fields scored (name/image/description/external_url). floor_eth is
// DELIBERATELY skipped — see metrics.go for the rationale.
//
// The image lives inside meta.content[] as the first entry where
// `@type=="IMAGE"`. There can be multiple representations (ORIGINAL /
// PREVIEW); we pick the first IMAGE in array order, which is what the
// validation harness did.
type RaribleCollectionResponse struct {
	Meta struct {
		Name         string `json:"name"`
		Description  string `json:"description"`
		ExternalLink string `json:"externalLink"`
		Content      []struct {
			Type string `json:"@type"`
			URL  string `json:"url"`
		} `json:"content"`
	} `json:"meta"`
}

var raribleClient = &http.Client{Timeout: 10 * time.Second}

func checkRarible(coll NFTCollection, apiKey, region string) NFTResult {
	res := newResult("rarible", coll.Name)

	if apiKey == "" {
		res.Error = "missing_api_key"
		res.ErrorType = "config"
		recordError("rarible", region, "config")
		return res
	}

	url := fmt.Sprintf("https://api.rarible.org/v0.1/collections/ETHEREUM:%s", coll.Contract)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("X-API-KEY", apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	start := time.Now()
	resp, err := raribleClient.Do(req)
	res.LatencyMs = float64(time.Since(start).Milliseconds())
	recordLatency("rarible", region, res.LatencyMs)

	if err != nil {
		res.Error = err.Error()
		res.ErrorType = classifyNetError(err)
		recordError("rarible", region, res.ErrorType)
		return res
	}
	defer resp.Body.Close()
	res.StatusCode = resp.StatusCode

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 404 {
		// Some legacy collections (CryptoPunks) are unindexed on Rarible.
		// Mark the 4 scored fields as `false` so the denominator still moves
		// — we want the coverage % to reflect that this collection isn't
		// indexed, not silently exclude it.
		res.Error = "not_found"
		res.ErrorType = "not_found"
		recordError("rarible", region, "not_found")
		res.Fields["name"] = false
		res.Fields["image"] = false
		res.Fields["description"] = false
		res.Fields["external_url"] = false
		return res
	}

	if resp.StatusCode != 200 {
		res.Error = fmt.Sprintf("status_%d", resp.StatusCode)
		res.ErrorType = classifyHTTPStatus(resp.StatusCode)
		recordError("rarible", region, res.ErrorType)
		return res
	}

	var parsed RaribleCollectionResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Error = "parse_error: " + err.Error()
		res.ErrorType = "parse_error"
		recordError("rarible", region, "parse_error")
		return res
	}

	imageURL := ""
	for _, c := range parsed.Meta.Content {
		if c.Type == "IMAGE" && c.URL != "" {
			imageURL = c.URL
			break
		}
	}

	res.Fields["name"] = strNonEmpty(parsed.Meta.Name)
	res.Fields["image"] = strNonEmpty(imageURL)
	res.Fields["description"] = strNonEmpty(parsed.Meta.Description)
	res.Fields["external_url"] = strNonEmpty(parsed.Meta.ExternalLink)
	// floor_eth intentionally absent — Rarible exposes bid floor only.
	return res
}
