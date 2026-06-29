package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// NFTResult is the per-provider per-collection probe outcome. `Fields` maps
// each scored field name to whether the provider returned a usable value. The
// 5 keys are always: name, image, description, floor_eth, external_url —
// except Rarible which omits floor_eth because the venue only exposes a bid
// floor (see metrics.go for the apple-to-apple rationale).
type NFTResult struct {
	Provider   string
	Collection string
	Fields     map[string]bool   // field -> present
	Values     map[string]string // field -> raw value (logged only, not metric)
	LatencyMs  float64
	StatusCode int
	Error      string // empty when ok
	ErrorType  string // populated when Error != ""
}

func newResult(provider, collection string) NFTResult {
	return NFTResult{
		Provider:   provider,
		Collection: collection,
		Fields:     map[string]bool{},
		Values:     map[string]string{},
	}
}

// strNonEmpty is the "field counts" predicate for string fields: non-empty
// after trim. JSON null and missing keys naturally land as "" via the typed
// unmarshal so we don't have to special-case them.
func strNonEmpty(s string) bool { return s != "" }

// numPositive is the predicate for numeric fields (floor_eth). Zero is treated
// as "no floor" because every provider returns 0 when they have no listing —
// indistinguishable from "missing" for the purposes of coverage scoring.
func numPositive(f float64) bool { return f > 0 }

// parseFloorString accepts the providers that return floor as a JSON string
// (Moralis: "8.95"). Falls back to 0 on parse error.
func parseFloorString(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

// MoralisCollectionResponse covers the fields we score plus the few extras we
// keep for log lines. The shape comes from GET /nft/{contract}/metadata which
// returns a flat object (no wrapping `data`).
type MoralisCollectionResponse struct {
	Name            string `json:"name"`
	CollectionLogo  string `json:"collection_logo"`
	Description     string `json:"description"`
	FloorPrice      string `json:"floor_price"`
	ProjectURL      string `json:"project_url"`
}

var moralisClient = &http.Client{Timeout: 10 * time.Second}

func checkMoralis(coll NFTCollection, apiKey, region string) NFTResult {
	res := newResult("moralis", coll.Name)

	if apiKey == "" {
		res.Error = "missing_api_key"
		res.ErrorType = "config"
		recordError("moralis", region, "config")
		return res
	}

	url := fmt.Sprintf("https://deep-index.moralis.io/api/v2.2/nft/%s/metadata?chain=eth", coll.Contract)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		res.Error = err.Error()
		res.ErrorType = "request_error"
		recordError("moralis", region, "request_error")
		return res
	}
	req.Header.Set("X-API-Key", apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	start := time.Now()
	resp, err := moralisClient.Do(req)
	res.LatencyMs = float64(time.Since(start).Milliseconds())
	recordLatency("moralis", region, res.LatencyMs)

	if err != nil {
		res.Error = err.Error()
		res.ErrorType = classifyNetError(err)
		recordError("moralis", region, res.ErrorType)
		return res
	}
	defer resp.Body.Close()
	res.StatusCode = resp.StatusCode

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		res.Error = fmt.Sprintf("status_%d", resp.StatusCode)
		res.ErrorType = classifyHTTPStatus(resp.StatusCode)
		recordError("moralis", region, res.ErrorType)
		return res
	}

	var parsed MoralisCollectionResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		res.Error = "parse_error: " + err.Error()
		res.ErrorType = "parse_error"
		recordError("moralis", region, "parse_error")
		return res
	}

	floor := parseFloorString(parsed.FloorPrice)
	res.Fields["name"] = strNonEmpty(parsed.Name)
	res.Fields["image"] = strNonEmpty(parsed.CollectionLogo)
	res.Fields["description"] = strNonEmpty(parsed.Description)
	res.Fields["floor_eth"] = numPositive(floor)
	res.Fields["external_url"] = strNonEmpty(parsed.ProjectURL)
	res.Values["floor_eth"] = parsed.FloorPrice
	return res
}
