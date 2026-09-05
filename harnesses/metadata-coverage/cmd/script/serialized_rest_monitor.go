package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// Serialized — token metadata coverage
//
// GET /v1/token/metadata?chain=<chain>&address=<addr> returns the four
// canonical fields this bench scores, under different names than Mobula
// and Codex:
//
//	logo        -> iconUrl
//	description -> description
//	twitter     -> twitterUrl
//	website     -> websiteUrl
//
// Chain ids are already in the bench's own shape ("solana", "evm:56",
// "evm:8453"), so no translation table is needed beyond normalising the
// legacy "solana:solana" form that Pulse V2 sometimes emits.
//
// One asymmetry worth knowing when reading the leaderboard: Serialized
// returns the *upstream* icon URL (ipfs.io, cdn.dexscreener.com, twimg,
// launchpad CDNs) while Mobula rewrites every logo onto its own CDN at a
// deterministic path, so Mobula's logo field is non-empty by construction.
// The bench currently scores "field non-empty", not "image resolves".
// See docs/methodology/serialized-onboarding-audit.md §6.
// ============================================================================

const serializedTokenMetadataURL = "https://api.serialized.xyz/v1/token/metadata"

// Serialized enforces a hard burst cap of 40 requests per second per key
// and returns 429 above it. The queue-driven monitor can burst well past
// that during a launch spike, which would show up as coverage loss rather
// than as a rate-limit error. Pace the calls at a fixed floor instead.
var (
	serializedMetaMu   sync.Mutex
	serializedMetaLast time.Time
)

const serializedMetaMinInterval = 60 * time.Millisecond // ~16 rps against a 40 rps cap

func serializedMetaThrottle() {
	serializedMetaMu.Lock()
	defer serializedMetaMu.Unlock()
	if wait := time.Until(serializedMetaLast.Add(serializedMetaMinInterval)); wait > 0 {
		time.Sleep(wait)
	}
	serializedMetaLast = time.Now()
}

// serializedChainID normalises the bench's chain id to what Serialized
// accepts. Returns false when the chain is outside their coverage, so the
// caller skips the check instead of recording a miss.
func serializedChainID(chainID string) (string, bool) {
	c := chainID
	if c == "solana:solana" {
		c = "solana"
	}
	if c == "solana" {
		return c, true
	}
	if !strings.HasPrefix(c, "evm:") {
		return "", false
	}
	// 18 EVM chains, live as of onboarding (2026-09-05).
	switch c {
	case "evm:1", "evm:56", "evm:130", "evm:143", "evm:196", "evm:988",
		"evm:1514", "evm:2741", "evm:4217", "evm:4326", "evm:4663",
		"evm:5042", "evm:8453", "evm:9745", "evm:42161", "evm:43114",
		"evm:57073", "evm:645749":
		return c, true
	}
	return "", false
}

type SerializedTokenMetadataResponse struct {
	Data struct {
		Name        string `json:"name"`
		Symbol      string `json:"symbol"`
		IconURL     string `json:"iconUrl"`
		Description string `json:"description"`
		TwitterURL  string `json:"twitterUrl"`
		WebsiteURL  string `json:"websiteUrl"`
		TelegramURL string `json:"telegramUrl"`
	} `json:"data"`
}

func checkSerializedMetadata(token TokenToCheck, apiKey string) MetadataFields {
	result := MetadataFields{}

	chain, ok := serializedChainID(token.ChainID)
	if !ok {
		result.Error = "chain_unsupported"
		return result
	}
	if apiKey == "" {
		result.Error = "no_api_key"
		return result
	}

	serializedMetaThrottle()

	params := url.Values{}
	params.Add("chain", chain)
	params.Add("address", token.Address)

	req, err := http.NewRequest("GET", fmt.Sprintf("%s?%s", serializedTokenMetadataURL, params.Encode()), nil)
	if err != nil {
		result.Error = fmt.Sprintf("request_create_error: %v", err)
		return result
	}
	// Raw key, no Bearer prefix — a prefixed key is rejected with 401.
	req.Header.Set("Authorization", apiKey)
	req.Header.Set("Accept", "application/json")

	startTime := time.Now()
	resp, err := metadataClient.Do(req)
	result.ResponseTimeMs = float64(time.Since(startTime).Milliseconds())
	if err != nil {
		result.Error = fmt.Sprintf("request_error: %v", err)
		return result
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		result.Error = fmt.Sprintf("status_%d", resp.StatusCode)
		return result
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		result.Error = fmt.Sprintf("read_error: %v", err)
		return result
	}

	var response SerializedTokenMetadataResponse
	if err := json.Unmarshal(body, &response); err != nil {
		result.Error = fmt.Sprintf("parse_error: %v", err)
		return result
	}

	d := response.Data
	result.HasName = d.Name != ""
	result.HasSymbol = d.Symbol != ""
	result.HasLogo = d.IconURL != ""
	result.LogoURL = d.IconURL
	result.HasDescription = d.Description != ""
	result.HasTwitter = d.TwitterURL != ""
	result.HasWebsite = d.WebsiteURL != ""
	result.HasTelegram = d.TelegramURL != ""

	return result
}
