package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// ============================================================================
// Metastreams — token metadata coverage
//
// GET /v1/tokens?tokens=<addr>&chains=<slug> returns an array with one object
// per chain that holds the token. The four fields this bench scores:
//
//	logo        -> logo.large (logo is {small, medium, large} or null)
//	description -> metadata.description
//	twitter     -> metadata.twitter
//	website     -> metadata.website
//
// Chains: solana and bsc are the two bench chains they index (their others
// are robinhood and elysium). Base and Monad are skipped, not scored as a
// miss, the same way Serialized is skipped outside its chains.
//
// An empty array means the token is not indexed. It is recorded as the
// error token_not_found and excluded from coverage, the rule Codex and
// Jupiter follow, so every provider's figure reads "fields populated on the
// tokens it answered for".
// ============================================================================

const metastreamsTokensURL = "https://api.metastreams.io/v1/tokens"

var (
	metastreamsMetaMu   sync.Mutex
	metastreamsMetaLast time.Time
)

// The key's x-ratelimit-remaining starts at 9 on a fresh window, so stay
// well under 10 requests a second.
const metastreamsMetaMinInterval = 150 * time.Millisecond

func metastreamsMetaThrottle() {
	metastreamsMetaMu.Lock()
	defer metastreamsMetaMu.Unlock()
	if wait := time.Until(metastreamsMetaLast.Add(metastreamsMetaMinInterval)); wait > 0 {
		time.Sleep(wait)
	}
	metastreamsMetaLast = time.Now()
}

func metastreamsChainSlug(chainID string) (string, bool) {
	switch chainID {
	case "solana", "solana:solana":
		return "solana", true
	case "evm:56":
		return "bsc", true
	case "evm:4663":
		return "robinhood", true
	}
	return "", false
}

type metastreamsToken struct {
	Name   string `json:"name"`
	Symbol string `json:"symbol"`
	Logo   *struct {
		Small  string `json:"small"`
		Medium string `json:"medium"`
		Large  string `json:"large"`
	} `json:"logo"`
	Metadata *struct {
		Description *string `json:"description"`
		Website     *string `json:"website"`
		Twitter     *string `json:"twitter"`
		Telegram    *string `json:"telegram"`
	} `json:"metadata"`
}

func nonEmpty(p *string) bool { return p != nil && *p != "" }

func checkMetastreamsMetadata(token TokenToCheck, apiKey string) MetadataFields {
	result := MetadataFields{}
	slug, ok := metastreamsChainSlug(token.ChainID)
	if !ok {
		result.Error = "chain_unsupported"
		return result
	}
	if apiKey == "" {
		result.Error = "no_api_key"
		return result
	}
	metastreamsMetaThrottle()

	params := url.Values{}
	params.Add("tokens", token.Address)
	params.Add("chains", slug)
	req, err := http.NewRequest("GET", metastreamsTokensURL+"?"+params.Encode(), nil)
	if err != nil {
		result.Error = fmt.Sprintf("request_create_error: %v", err)
		return result
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")

	start := time.Now()
	resp, err := metadataClient.Do(req)
	result.ResponseTimeMs = float64(time.Since(start).Milliseconds())
	if err != nil {
		result.Error = fmt.Sprintf("request_error: %v", err)
		return result
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		result.Error = fmt.Sprintf("status_%d", resp.StatusCode)
		return result
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		result.Error = fmt.Sprintf("read_error: %v", err)
		return result
	}
	var tokens []metastreamsToken
	if err := json.Unmarshal(body, &tokens); err != nil {
		result.Error = fmt.Sprintf("parse_error: %v", err)
		return result
	}
	if len(tokens) == 0 {
		result.Error = "token_not_found"
		return result
	}
	t := tokens[0]
	result.HasName = t.Name != ""
	result.HasSymbol = t.Symbol != ""
	if t.Logo != nil && t.Logo.Large != "" {
		result.HasLogo = true
		result.LogoURL = t.Logo.Large
	}
	if t.Metadata != nil {
		result.HasDescription = nonEmpty(t.Metadata.Description)
		result.HasTwitter = nonEmpty(t.Metadata.Twitter)
		result.HasWebsite = nonEmpty(t.Metadata.Website)
		result.HasTelegram = nonEmpty(t.Metadata.Telegram)
	}
	return result
}
