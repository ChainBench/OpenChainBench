package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// Metadata Coverage Monitor
// Measures metadata and logo coverage across providers (Mobula, Codex)
// ============================================================================

const (
	mobulaTokenDetailsURL = "https://api.mobula.io/api/2/token/details"
	codexGraphQLURL       = "https://graph.codex.io/graphql"
	jupiterTokenPageURL   = "https://jup.ag/tokens/"
)

// TokenToCheck represents a token discovered via Pulse that needs metadata checking
type TokenToCheck struct {
	Address    string
	ChainID    string // e.g., "solana", "evm:1", "evm:8453"
	Symbol     string
	Name       string
	DetectedAt time.Time
}

// MetadataFields represents the fields we check for coverage
type MetadataFields struct {
	HasLogo        bool
	HasName        bool
	HasSymbol      bool
	HasDescription bool
	HasTwitter     bool
	HasWebsite     bool
	HasTelegram    bool
	LogoURL        string
	ResponseTimeMs float64
	Error          string
}

// ProviderCoverage holds coverage stats for a single provider
type ProviderCoverage struct {
	Provider       string
	TotalChecks    int
	LogoCount      int
	NameCount      int
	SymbolCount    int
	DescCount      int
	TwitterCount   int
	WebsiteCount   int
	TelegramCount  int
	ErrorCount     int
	TotalLatencyMs float64
}

// MetadataCoverageStats holds overall stats
type MetadataCoverageStats struct {
	mu        sync.Mutex
	Mobula    ProviderCoverage
	Codex     ProviderCoverage
	Jupiter   ProviderCoverage
	LastPrint time.Time
}

var (
	coverageStats = &MetadataCoverageStats{
		Mobula:  ProviderCoverage{Provider: "mobula"},
		Codex:   ProviderCoverage{Provider: "codex"},
		Jupiter: ProviderCoverage{Provider: "jupiter"},
	}
	tokenQueue     = make(chan TokenToCheck, 500)
	metadataClient = &http.Client{Timeout: 10 * time.Second}
)

// ============================================================================
// Mobula API - Token Details
// ============================================================================

type MobulaTokenDetailsResponse struct {
	Data MobulaTokenData `json:"data"`
}

type MobulaTokenData struct {
	Address     string        `json:"address"`
	Name        string        `json:"name"`
	Symbol      string        `json:"symbol"`
	Logo        string        `json:"logo"`
	Description string        `json:"description"`
	Socials     MobulaSocials `json:"socials"`
}

type MobulaSocials struct {
	Twitter  string `json:"twitter"`
	Website  string `json:"website"`
	Telegram string `json:"telegram"`
}

func checkMobulaMetadata(token TokenToCheck, apiKey string) MetadataFields {
	result := MetadataFields{}

	// Build URL with query params
	params := url.Values{}
	params.Add("address", token.Address)

	// Convert chainID to Mobula format
	blockchain := token.ChainID
	if blockchain == "solana:solana" {
		blockchain = "solana"
	}
	params.Add("blockchain", blockchain)

	fullURL := fmt.Sprintf("%s?%s", mobulaTokenDetailsURL, params.Encode())

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		result.Error = fmt.Sprintf("request_create_error: %v", err)
		return result
	}

	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", apiKey)
	}

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

	var response MobulaTokenDetailsResponse
	if err := json.Unmarshal(body, &response); err != nil {
		result.Error = fmt.Sprintf("parse_error: %v", err)
		return result
	}

	data := response.Data

	// Check each field
	result.HasName = data.Name != ""
	result.HasSymbol = data.Symbol != ""
	result.HasLogo = data.Logo != ""
	result.LogoURL = data.Logo
	result.HasDescription = data.Description != ""
	result.HasTwitter = data.Socials.Twitter != ""
	result.HasWebsite = data.Socials.Website != ""
	result.HasTelegram = data.Socials.Telegram != ""

	return result
}

// ============================================================================
// Codex API - GraphQL Token Query
// ============================================================================

// Note: CodexGraphQLRequest is defined in codex_rest_monitor.go

// CodexTokenResponse represents the response from token query
// Returns EnhancedToken with socialLinks and info
// https://docs.codex.io/api-reference/queries/token
type CodexTokenResponse struct {
	Data struct {
		Token CodexEnhancedToken `json:"token"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// CodexEnhancedToken matches the EnhancedToken type from Codex API
type CodexEnhancedToken struct {
	Address     string           `json:"address"`
	Name        string           `json:"name"`
	Symbol      string           `json:"symbol"`
	Decimals    int              `json:"decimals"`
	NetworkID   int              `json:"networkId"`
	Info        *CodexTokenInfo  `json:"info"`
	SocialLinks *CodexSocialLinks `json:"socialLinks"`
}

// CodexTokenInfo contains metadata about the token
type CodexTokenInfo struct {
	ImageThumbUrl     string `json:"imageThumbUrl"`
	ImageSmallUrl     string `json:"imageSmallUrl"`
	ImageLargeUrl     string `json:"imageLargeUrl"`
	Description       string `json:"description"`
	CirculatingSupply string `json:"circulatingSupply"`
	TotalSupply       string `json:"totalSupply"`
}

// CodexSocialLinks contains social media links for the token
type CodexSocialLinks struct {
	Twitter   string `json:"twitter"`
	Website   string `json:"website"`
	Telegram  string `json:"telegram"`
	Discord   string `json:"discord"`
	Github    string `json:"github"`
}

func getCodexNetworkID(chainID string) int {
	switch chainID {
	case "solana", "solana:solana":
		return 1399811149
	case "evm:1":
		return 1
	case "evm:8453":
		return 8453
	case "evm:56":
		return 56
	case "evm:42161":
		return 42161
	default:
		return 0
	}
}

func checkCodexMetadata(token TokenToCheck, sessionCookie string) MetadataFields {
	// Try once. If Codex returns 401 / UNAUTHENTICATED, invalidate the JWT
	// cache and retry once. This recovers automatically when the cached JWT
	// expired between mint and use, without waiting for a manual cookie reset.
	result := codexMetadataAttempt(token, sessionCookie)
	if codexAuthFailed(result) {
		fmt.Printf("[META][CODEX][retry] %s | %s | invalidating JWT cache after %s\n",
			token.ChainID, token.Symbol, result.Error)
		InvalidateTokenCache()
		result = codexMetadataAttempt(token, sessionCookie)
	}
	return result
}

func codexAuthFailed(r MetadataFields) bool {
	return strings.HasPrefix(r.Error, "status_401") ||
		strings.Contains(r.Error, "User is not authenticated") ||
		strings.Contains(r.Error, "Not authorized")
}

func codexMetadataAttempt(token TokenToCheck, sessionCookie string) MetadataFields {
	result := MetadataFields{}

	networkID := getCodexNetworkID(token.ChainID)
	if networkID == 0 {
		result.Error = "unsupported_chain"
		return result
	}

	// Codex GraphQL no longer accepts the raw Defined session cookie as Bearer
	// (returns 401 UNAUTHENTICATED). Mint a JWT from the cookie via defined.fi/api
	// and use that as Bearer — same path as the head_lag WS monitor.
	apiKey, err := GetDefinedJWTToken(sessionCookie)
	if err != nil {
		recordCodexJWT(0, err.Error())
		result.Error = fmt.Sprintf("jwt_mint_error: %v", err)
		return result
	}
	recordCodexJWT(len(apiKey), "")

	// Use token query which returns EnhancedToken with socialLinks and info
	// https://docs.codex.io/api-reference/queries/token
	query := `query GetToken($address: String!, $networkId: Int!) {
		token(input: { address: $address, networkId: $networkId }) {
			address
			name
			symbol
			decimals
			networkId
			info {
				imageThumbUrl
				imageSmallUrl
				imageLargeUrl
				description
				circulatingSupply
				totalSupply
			}
			socialLinks {
				twitter
				website
				telegram
				discord
				github
			}
		}
	}`

	reqBody := CodexGraphQLRequest{
		Query: query,
		Variables: map[string]interface{}{
			"address":   token.Address,
			"networkId": networkID,
		},
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		result.Error = fmt.Sprintf("marshal_error: %v", err)
		return result
	}

	req, err := http.NewRequest("POST", codexGraphQLURL, bytes.NewBuffer(jsonBody))
	if err != nil {
		result.Error = fmt.Sprintf("request_create_error: %v", err)
		return result
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", apiKey))
	}

	startTime := time.Now()
	resp, err := metadataClient.Do(req)
	result.ResponseTimeMs = float64(time.Since(startTime).Milliseconds())

	debug := codexDebugEntry{
		At:        time.Now().UTC().Format(time.RFC3339),
		Chain:     token.ChainID,
		Address:   token.Address,
		LatencyMs: int(result.ResponseTimeMs),
	}

	if err != nil {
		result.Error = fmt.Sprintf("request_error: %v", err)
		debug.Error = result.Error
		recordCodexCall(debug)
		return result
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	debug.StatusCode = resp.StatusCode
	if len(body) > 400 {
		debug.BodySample = string(body[:400])
	} else {
		debug.BodySample = string(body)
	}

	if resp.StatusCode != 200 {
		result.Error = fmt.Sprintf("status_%d", resp.StatusCode)
		debug.Error = result.Error
		recordCodexCall(debug)
		return result
	}

	var response CodexTokenResponse
	if err := json.Unmarshal(body, &response); err != nil {
		result.Error = fmt.Sprintf("parse_error: %v", err)
		debug.Error = result.Error
		recordCodexCall(debug)
		return result
	}

	if len(response.Errors) > 0 {
		result.Error = fmt.Sprintf("graphql_error: %s", response.Errors[0].Message)
		debug.Error = result.Error
		recordCodexCall(debug)
		return result
	}

	recordCodexCall(debug)
	data := response.Data.Token

	// Check if token was found
	if data.Address == "" {
		result.Error = "token_not_found"
		return result
	}

	// Check each field based on EnhancedToken
	// https://docs.codex.io/api-reference/queries/token
	result.HasName = data.Name != ""
	result.HasSymbol = data.Symbol != ""

	// Check logo from info
	if data.Info != nil {
		result.HasLogo = data.Info.ImageThumbUrl != "" || data.Info.ImageSmallUrl != "" || data.Info.ImageLargeUrl != ""
		if data.Info.ImageLargeUrl != "" {
			result.LogoURL = data.Info.ImageLargeUrl
		} else if data.Info.ImageSmallUrl != "" {
			result.LogoURL = data.Info.ImageSmallUrl
		} else {
			result.LogoURL = data.Info.ImageThumbUrl
		}
		result.HasDescription = data.Info.Description != ""
	}

	// Check social links
	if data.SocialLinks != nil {
		result.HasTwitter = data.SocialLinks.Twitter != ""
		result.HasWebsite = data.SocialLinks.Website != ""
		result.HasTelegram = data.SocialLinks.Telegram != ""
	}

	return result
}

// ============================================================================
// Jupiter - Scraping from frontend (Solana only)
// ============================================================================

// JupiterNextData represents the __NEXT_DATA__ JSON structure
type JupiterNextData struct {
	Props struct {
		PageProps struct {
			DehydratedState struct {
				Queries []struct {
					State struct {
						Data JupiterTokenData `json:"data"`
					} `json:"state"`
				} `json:"queries"`
			} `json:"dehydratedState"`
		} `json:"pageProps"`
	} `json:"props"`
}

// JupiterTokenData represents token data from Jupiter
type JupiterTokenData struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Symbol   string `json:"symbol"`
	Icon     string `json:"icon"`
	Decimals int    `json:"decimals"`
}

func checkJupiterMetadata(token TokenToCheck) MetadataFields {
	result := MetadataFields{}

	// Jupiter only supports Solana
	if token.ChainID != "solana" && token.ChainID != "solana:solana" {
		result.Error = "unsupported_chain"
		return result
	}

	// Scrape the token page
	pageURL := jupiterTokenPageURL + token.Address

	req, err := http.NewRequest("GET", pageURL, nil)
	if err != nil {
		result.Error = fmt.Sprintf("request_create_error: %v", err)
		return result
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

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

	// Extract __NEXT_DATA__ JSON from HTML
	htmlContent := string(body)
	startMarker := `<script id="__NEXT_DATA__" type="application/json">`
	endMarker := `</script>`

	startIdx := -1
	for i := 0; i < len(htmlContent)-len(startMarker); i++ {
		if htmlContent[i:i+len(startMarker)] == startMarker {
			startIdx = i + len(startMarker)
			break
		}
	}

	if startIdx == -1 {
		result.Error = "next_data_not_found"
		return result
	}

	endIdx := -1
	for i := startIdx; i < len(htmlContent)-len(endMarker); i++ {
		if htmlContent[i:i+len(endMarker)] == endMarker {
			endIdx = i
			break
		}
	}

	if endIdx == -1 {
		result.Error = "next_data_end_not_found"
		return result
	}

	jsonData := htmlContent[startIdx:endIdx]

	var nextData JupiterNextData
	if err := json.Unmarshal([]byte(jsonData), &nextData); err != nil {
		result.Error = fmt.Sprintf("parse_error: %v", err)
		return result
	}

	// Find token data in queries
	var tokenData JupiterTokenData
	for _, query := range nextData.Props.PageProps.DehydratedState.Queries {
		if query.State.Data.ID == token.Address {
			tokenData = query.State.Data
			break
		}
	}

	if tokenData.ID == "" {
		result.Error = "token_not_found"
		return result
	}

	// Check fields - Jupiter only has basic on-chain data
	result.HasName = tokenData.Name != ""
	result.HasSymbol = tokenData.Symbol != ""
	result.HasLogo = tokenData.Icon != ""
	result.LogoURL = tokenData.Icon
	// Jupiter doesn't have description or socials
	result.HasDescription = false
	result.HasTwitter = false
	result.HasWebsite = false
	result.HasTelegram = false

	return result
}

// ============================================================================
// Stats and Reporting
// ============================================================================

func updateStats(provider string, fields MetadataFields) {
	coverageStats.mu.Lock()
	defer coverageStats.mu.Unlock()

	var stats *ProviderCoverage
	switch provider {
	case "mobula":
		stats = &coverageStats.Mobula
	case "codex":
		stats = &coverageStats.Codex
	case "jupiter":
		stats = &coverageStats.Jupiter
	default:
		return
	}

	stats.TotalChecks++
	stats.TotalLatencyMs += fields.ResponseTimeMs

	if fields.Error != "" {
		stats.ErrorCount++
		return
	}

	if fields.HasLogo {
		stats.LogoCount++
	}
	if fields.HasName {
		stats.NameCount++
	}
	if fields.HasSymbol {
		stats.SymbolCount++
	}
	if fields.HasDescription {
		stats.DescCount++
	}
	if fields.HasTwitter {
		stats.TwitterCount++
	}
	if fields.HasWebsite {
		stats.WebsiteCount++
	}
	if fields.HasTelegram {
		stats.TelegramCount++
	}
}

func printCoverageStats() {
	coverageStats.mu.Lock()
	defer coverageStats.mu.Unlock()

	timestamp := time.Now().UTC().Format("2006-01-02 15:04:05")

	fmt.Printf("\n")
	fmt.Printf("╔══════════════════════════════════════════════════════════════════════════════╗\n")
	fmt.Printf("║                    METADATA COVERAGE STATS - %s                   ║\n", timestamp)
	fmt.Printf("╠══════════════════════════════════════════════════════════════════════════════╣\n")
	fmt.Printf("║ Provider │ Checks │ Logo  │ Name  │ Symbol│ Desc  │Twitter│Website│Telegram│ Errors │\n")
	fmt.Printf("╠══════════════════════════════════════════════════════════════════════════════╣\n")

	for _, stats := range []*ProviderCoverage{&coverageStats.Mobula, &coverageStats.Codex, &coverageStats.Jupiter} {
		if stats.TotalChecks == 0 {
			fmt.Printf("║ %-8s │ %6d │   -   │   -   │   -   │   -   │   -   │   -   │   -    │ %6d ║\n",
				stats.Provider, stats.TotalChecks, stats.ErrorCount)
			continue
		}

		successChecks := stats.TotalChecks - stats.ErrorCount
		if successChecks == 0 {
			successChecks = 1 // Avoid division by zero
		}

		fmt.Printf("║ %-8s │ %6d │ %5.1f%%│ %5.1f%%│ %5.1f%%│ %5.1f%%│ %5.1f%%│ %5.1f%%│ %5.1f%% │ %6d ║\n",
			stats.Provider,
			stats.TotalChecks,
			float64(stats.LogoCount)/float64(successChecks)*100,
			float64(stats.NameCount)/float64(successChecks)*100,
			float64(stats.SymbolCount)/float64(successChecks)*100,
			float64(stats.DescCount)/float64(successChecks)*100,
			float64(stats.TwitterCount)/float64(successChecks)*100,
			float64(stats.WebsiteCount)/float64(successChecks)*100,
			float64(stats.TelegramCount)/float64(successChecks)*100,
			stats.ErrorCount,
		)
	}

	fmt.Printf("╚══════════════════════════════════════════════════════════════════════════════╝\n")
	fmt.Printf("\n")

	coverageStats.LastPrint = time.Now()
}

func chainNameFromPulseChainID(chainID string) string {
	switch chainID {
	case "solana:solana":
		return "solana"
	case "evm:56":
		return "bnb"
	case "evm:8453":
		return "base"
	case "evm:143":
		return "monad"
	default:
		return chainID
	}
}

func checkTokenMetadata(token TokenToCheck, config *Config) {
	chainName := chainNameFromPulseChainID(token.ChainID)

	// Check Mobula
	mobulaResult := checkMobulaMetadata(token, config.MobulaAPIKey)
	updateStats("mobula", mobulaResult)

	// Record Prometheus metrics for Mobula
	RecordMetadataCoverage("mobula", chainName, "logo", mobulaResult.HasLogo, config.MonitorRegion)
	RecordMetadataCoverage("mobula", chainName, "description", mobulaResult.HasDescription, config.MonitorRegion)
	RecordMetadataCoverage("mobula", chainName, "twitter", mobulaResult.HasTwitter, config.MonitorRegion)
	RecordMetadataCoverage("mobula", chainName, "website", mobulaResult.HasWebsite, config.MonitorRegion)
	RecordMetadataLatency("mobula", chainName, mobulaResult.ResponseTimeMs, config.MonitorRegion)

	// Check Codex
	codexResult := checkCodexMetadata(token, config.DefinedSessionCookie)
	if codexResult.Error != "" {
		fmt.Printf("[META][CODEX][%s] %s | %s | err=%s\n",
			chainName, token.Symbol, token.Address, codexResult.Error)
	}
	updateStats("codex", codexResult)

	// Record Prometheus metrics for Codex
	RecordMetadataCoverage("codex", chainName, "logo", codexResult.HasLogo, config.MonitorRegion)
	RecordMetadataCoverage("codex", chainName, "description", codexResult.HasDescription, config.MonitorRegion)
	RecordMetadataCoverage("codex", chainName, "twitter", codexResult.HasTwitter, config.MonitorRegion)
	RecordMetadataCoverage("codex", chainName, "website", codexResult.HasWebsite, config.MonitorRegion)
	RecordMetadataLatency("codex", chainName, codexResult.ResponseTimeMs, config.MonitorRegion)

	// Check Jupiter (Solana only - scraping frontend)
	var jupiterResult MetadataFields
	if token.ChainID == "solana" || token.ChainID == "solana:solana" {
		jupiterResult = checkJupiterMetadata(token)
		updateStats("jupiter", jupiterResult)

		// Record Prometheus metrics for Jupiter
		RecordMetadataCoverage("jupiter", chainName, "logo", jupiterResult.HasLogo, config.MonitorRegion)
		RecordMetadataCoverage("jupiter", chainName, "description", jupiterResult.HasDescription, config.MonitorRegion)
		RecordMetadataCoverage("jupiter", chainName, "twitter", jupiterResult.HasTwitter, config.MonitorRegion)
		RecordMetadataCoverage("jupiter", chainName, "website", jupiterResult.HasWebsite, config.MonitorRegion)
		RecordMetadataLatency("jupiter", chainName, jupiterResult.ResponseTimeMs, config.MonitorRegion)
	}

	// Single condensed log line
	boolToIcon := func(b bool) string {
		if b {
			return "✓"
		}
		return "✗"
	}

	jupiterLogo := "-"
	if token.ChainID == "solana" || token.ChainID == "solana:solana" {
		jupiterLogo = boolToIcon(jupiterResult.HasLogo)
	}

	fmt.Printf("[META] %s/%s | M:%s%s%s | C:%s%s%s | J:%s\n",
		token.Symbol, chainName,
		boolToIcon(mobulaResult.HasLogo), boolToIcon(mobulaResult.HasDescription), boolToIcon(mobulaResult.HasTwitter),
		boolToIcon(codexResult.HasLogo), boolToIcon(codexResult.HasDescription), boolToIcon(codexResult.HasTwitter),
		jupiterLogo)

	// Print stats every 50 checks (reduced from 10)
	coverageStats.mu.Lock()
	totalChecks := coverageStats.Mobula.TotalChecks
	coverageStats.mu.Unlock()

	if totalChecks > 0 && totalChecks%50 == 0 {
		printCoverageStats()
	}
}

// QueueTokenForMetadataCheck adds a token to the check queue
func QueueTokenForMetadataCheck(token TokenToCheck) {
	select {
	case tokenQueue <- token:
		// Token queued successfully
	default:
		// Queue full, skip this token
		fmt.Printf("[METADATA] Queue full, skipping token: %s\n", token.Address)
	}
}

// metadataCheckDelay is how long we wait after a Pulse detection before
// hitting the providers. 2s was our original value; it favours providers
// that enrich synchronously and penalises ones that enrich in
// background workers (Mobula). 30s by default gives every provider a
// fair chance to populate socials. Override with
// METADATA_CHECK_DELAY_SECONDS env var.
func metadataCheckDelay() time.Duration {
	if v := os.Getenv("METADATA_CHECK_DELAY_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return time.Duration(n) * time.Second
		}
	}
	return 30 * time.Second
}

// metadataCheckWorkers is how many goroutines pull from tokenQueue in
// parallel. With a longer delay (30s+) one worker can't keep up, so we
// fan out. Default 8 → ~8 tokens / 30s = ~16 tokens/min steady state.
func metadataCheckWorkers() int {
	if v := os.Getenv("METADATA_CHECK_WORKERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 8
}

// runMetadataCoverageMonitor starts the metadata coverage monitoring
func runMetadataCoverageMonitor(config *Config, stopChan <-chan struct{}) {
	delay := metadataCheckDelay()
	workers := metadataCheckWorkers()
	fmt.Println("Starting Metadata Coverage Monitor...")
	fmt.Println("   Comparing metadata coverage: Mobula vs Codex vs Jupiter")
	fmt.Println("   Fields tracked: Logo, Name, Symbol, Description, Twitter, Website, Telegram")
	fmt.Println("   Note: Jupiter only supports Solana and has no description/socials")
	fmt.Printf("   Check delay: %v (override with METADATA_CHECK_DELAY_SECONDS)\n", delay)
	fmt.Printf("   Workers: %d (override with METADATA_CHECK_WORKERS)\n", workers)
	fmt.Println("   Waiting for new tokens from Pulse stream...")
	fmt.Println()

	// Spawn N workers that each pull from tokenQueue, sleep `delay`, then
	// hit all 3 providers. The longer delay needs the parallelism so a
	// burst of tokens doesn't fill the queue faster than we drain it.
	for i := 0; i < workers; i++ {
		go func() {
			for {
				select {
				case <-stopChan:
					return
				case token := <-tokenQueue:
					time.Sleep(delay)
					checkTokenMetadata(token, config)
				}
			}
		}()
	}

	// Stats printer ticker - print every 5 minutes
	statsTicker := time.NewTicker(5 * time.Minute)
	defer statsTicker.Stop()

	for {
		select {
		case <-stopChan:
			fmt.Println("Metadata Coverage monitor stopped")
			printCoverageStats()
			return
		case <-statsTicker.C:
			printCoverageStats()
		}
	}
}

