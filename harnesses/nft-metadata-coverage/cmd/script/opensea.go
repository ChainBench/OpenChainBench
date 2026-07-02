package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// OpenSeaCollectionResponse: GET /api/v2/collections/{slug}. We extract name,
// description, image_url, project_url here; floor lives in a SEPARATE endpoint
// (see OpenSeaStatsResponse below) so each collection costs 2 OS calls.
type OpenSeaCollectionResponse struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	ImageURL    string `json:"image_url"`
	ProjectURL  string `json:"project_url"`
}

// OpenSeaStatsResponse: GET /api/v2/collections/{slug}/stats. The ask-side
// floor lives at stats.total.floor_price (a number in the listing currency,
// usually ETH).
type OpenSeaStatsResponse struct {
	Total struct {
		FloorPrice float64 `json:"floor_price"`
	} `json:"total"`
}

// OpenSeaContractResolveResponse: GET /api/v2/chain/ethereum/contract/{addr}.
// Used at startup to map a contract -> canonical slug. Without this we can't
// hit /collections/{slug} because OpenSea changed slugs on multiple blue
// chips post-rebrand.
type OpenSeaContractResolveResponse struct {
	Collection string `json:"collection"`
}

var openSeaClient = &http.Client{Timeout: 10 * time.Second}

// resolveOpenSeaSlug looks up the canonical OS slug from a contract address.
// Called once per collection at startup. Returns "" on failure; the caller
// then falls back to the seed slug from collections.go.
func resolveOpenSeaSlug(contract, apiKey, region string) (string, error) {
	url := fmt.Sprintf("https://api.opensea.io/api/v2/chain/ethereum/contract/%s", contract)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := openSeaClient.Do(req)
	if err != nil {
		recordError("opensea", region, "slug_resolve_error")
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		recordError("opensea", region, "slug_resolve_error")
		return "", fmt.Errorf("opensea slug resolve status %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var parsed OpenSeaContractResolveResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		recordError("opensea", region, "slug_resolve_error")
		return "", err
	}
	return parsed.Collection, nil
}

// checkOpenSea performs the 2-call sequence (collection + stats) and merges
// the result. Latency is the WALL-CLOCK sum of both calls — a fair
// representation of "what would a single coverage query against OpenSea
// look like" given they split the data.
func checkOpenSea(coll NFTCollection, apiKey, region string) NFTResult {
	res := newResult("opensea", coll.Name)

	if apiKey == "" {
		res.Error = "missing_api_key"
		res.ErrorType = "config"
		recordError("opensea", region, "config")
		return res
	}
	if coll.OpenSeaSlug == "" {
		res.Error = "missing_slug"
		res.ErrorType = "slug_resolve_error"
		recordError("opensea", region, "slug_resolve_error")
		return res
	}

	start := time.Now()

	// Call 1: collection metadata
	url1 := fmt.Sprintf("https://api.opensea.io/api/v2/collections/%s", coll.OpenSeaSlug)
	req1, _ := http.NewRequest("GET", url1, nil)
	req1.Header.Set("x-api-key", apiKey)
	req1.Header.Set("Accept", "application/json")
	req1.Header.Set("User-Agent", userAgent)

	resp1, err := openSeaClient.Do(req1)
	if err != nil {
		res.LatencyMs = float64(time.Since(start).Milliseconds())
		recordLatency("opensea", region, res.LatencyMs)
		res.Error = err.Error()
		res.ErrorType = classifyNetError(err)
		recordError("opensea", region, res.ErrorType)
		return res
	}
	defer resp1.Body.Close()
	res.StatusCode = resp1.StatusCode

	if resp1.StatusCode != 200 {
		res.LatencyMs = float64(time.Since(start).Milliseconds())
		recordLatency("opensea", region, res.LatencyMs)
		res.Error = fmt.Sprintf("status_%d", resp1.StatusCode)
		res.ErrorType = classifyHTTPStatus(resp1.StatusCode)
		recordError("opensea", region, res.ErrorType)
		return res
	}

	body1, _ := io.ReadAll(resp1.Body)
	var meta OpenSeaCollectionResponse
	if err := json.Unmarshal(body1, &meta); err != nil {
		res.LatencyMs = float64(time.Since(start).Milliseconds())
		recordLatency("opensea", region, res.LatencyMs)
		res.Error = "parse_error: " + err.Error()
		res.ErrorType = "parse_error"
		recordError("opensea", region, "parse_error")
		return res
	}

	// Call 2: stats (floor price). Non-fatal if it fails — we still score 4/5.
	url2 := fmt.Sprintf("https://api.opensea.io/api/v2/collections/%s/stats", coll.OpenSeaSlug)
	req2, _ := http.NewRequest("GET", url2, nil)
	req2.Header.Set("x-api-key", apiKey)
	req2.Header.Set("Accept", "application/json")
	req2.Header.Set("User-Agent", userAgent)

	var floor float64
	resp2, err2 := openSeaClient.Do(req2)
	if err2 == nil {
		if resp2.StatusCode == 200 {
			body2, _ := io.ReadAll(resp2.Body)
			var stats OpenSeaStatsResponse
			if jerr := json.Unmarshal(body2, &stats); jerr == nil {
				floor = stats.Total.FloorPrice
			}
		} else {
			recordError("opensea", region, "stats_"+classifyHTTPStatus(resp2.StatusCode))
		}
		resp2.Body.Close()
	} else {
		recordError("opensea", region, "stats_"+classifyNetError(err2))
	}

	res.LatencyMs = float64(time.Since(start).Milliseconds())
	recordLatency("opensea", region, res.LatencyMs)

	res.Fields["name"] = strNonEmpty(meta.Name)
	res.Fields["image"] = strNonEmpty(meta.ImageURL)
	res.Fields["description"] = strNonEmpty(meta.Description)
	res.Fields["floor_eth"] = numPositive(floor)
	res.Fields["external_url"] = strNonEmpty(meta.ProjectURL)
	res.Values["floor_eth"] = fmt.Sprintf("%g", floor)
	return res
}
