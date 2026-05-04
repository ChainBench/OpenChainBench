package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Quote API endpoints
const (
	// Free APIs (no API key required)
	jupiterPublicURL  = "https://public.jupiterapi.com/quote" // Free, 10 req/sec, Solana only
	mobulaSwapURL     = "https://api.mobula.io/api/2/swap/quoting" // Solana only for now
	openOceanQuoteURL = "https://open-api.openocean.finance/v3"
	paraSwapQuoteURL  = "https://apiv5.paraswap.io/prices"
	kyberSwapQuoteURL = "https://aggregator-api.kyberswap.com"
	lifiQuoteURL      = "https://li.quest/v1/quote"
)

// Dummy wallet addresses for APIs that require fromAddress
const dummyWalletAddressEVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"    // Vitalik's address (EVM)
const dummyWalletAddressSolana = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH" // Random Solana wallet

// Chain configurations for quote testing
type QuoteChainConfig struct {
	Name           string
	ChainID        string // Numeric chain ID
	OpenOceanChain string // OpenOcean chain key
	KyberChainKey  string // KyberSwap chain key
	TokenIn        string // Input token address
	TokenOut       string // Output token address
	TokenInSymbol  string
	TokenOutSymbol string
	Amount         string // Amount in smallest unit
	Decimals       int
}

// Solana config for Jupiter
var solanaConfig = QuoteChainConfig{
	Name:           "solana",
	TokenIn:        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
	TokenOut:       "So11111111111111111111111111111111111111112",  // SOL
	TokenInSymbol:  "USDC",
	TokenOutSymbol: "SOL",
	Amount:         "100000000", // 100 USDC (6 decimals)
	Decimals:       6,
}

// EVM chains config
var evmQuoteChains = []QuoteChainConfig{
	{
		Name:           "base",
		ChainID:        "8453",
		OpenOceanChain: "8453",
		KyberChainKey:  "base",
		TokenIn:        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
		TokenOut:       "0x4200000000000000000000000000000000000006", // WETH on Base
		TokenInSymbol:  "USDC",
		TokenOutSymbol: "WETH",
		Amount:         "100000000", // 100 USDC (6 decimals)
		Decimals:       6,
	},
	{
		Name:           "bnb",
		ChainID:        "56",
		OpenOceanChain: "56",
		KyberChainKey:  "bsc",
		TokenIn:        "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC on BSC (18 decimals)
		TokenOut:       "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
		TokenInSymbol:  "USDC",
		TokenOutSymbol: "WBNB",
		Amount:         "100000000000000000000", // 100 USDC (18 decimals on BSC)
		Decimals:       18,
	},
}

// HTTP client with timeout
var quoteHTTPClient = &http.Client{
	Timeout: 15 * time.Second,
}

// ============================================================================
// Mobula Swap Quoting API (Solana + Base + Arbitrum, requires API key)
// ============================================================================

func callMobulaSwapQuoteAPI(chainID string, chainName string, tokenIn string, tokenOut string, amount string, apiKey string) (float64, int, error) {
	// Use appropriate wallet address based on chain
	walletAddress := dummyWalletAddressEVM
	if chainName == "solana" {
		walletAddress = dummyWalletAddressSolana
	}

	params := url.Values{}
	params.Add("chainId", chainID)
	params.Add("tokenIn", tokenIn)
	params.Add("tokenOut", tokenOut)
	params.Add("amount", amount)
	params.Add("walletAddress", walletAddress)
	params.Add("slippage", "1")

	fullURL := fmt.Sprintf("%s?%s", mobulaSwapURL, params.Encode())

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", apiKey)
	}

	startTime := time.Now()
	resp, err := quoteHTTPClient.Do(req)
	latencyMs := float64(time.Since(startTime).Milliseconds())

	if err != nil {
		return latencyMs, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read body to check for errors
	body, _ := io.ReadAll(resp.Body)

	// Check for API errors in response body
	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err == nil {
		if errMsg, ok := result["error"]; ok && errMsg != nil {
			// Return 400 to indicate API error (even if HTTP was 200)
			return latencyMs, 400, nil
		}
	}

	return latencyMs, resp.StatusCode, nil
}

// ============================================================================
// Jupiter Public API (Solana only, FREE - 10 req/sec)
// ============================================================================

func callJupiterPublicQuoteAPI() (float64, int, error) {
	params := url.Values{}
	params.Add("inputMint", solanaConfig.TokenIn)
	params.Add("outputMint", solanaConfig.TokenOut)
	params.Add("amount", solanaConfig.Amount)
	params.Add("slippageBps", "50")

	fullURL := fmt.Sprintf("%s?%s", jupiterPublicURL, params.Encode())

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	startTime := time.Now()
	resp, err := quoteHTTPClient.Do(req)
	latencyMs := float64(time.Since(startTime).Milliseconds())

	if err != nil {
		return latencyMs, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	_, _ = io.ReadAll(resp.Body)

	return latencyMs, resp.StatusCode, nil
}

// ============================================================================
// OpenOcean API (Multi-chain, FREE)
// ============================================================================

func callOpenOceanQuoteAPI(chain QuoteChainConfig) (float64, int, error) {
	endpoint := fmt.Sprintf("%s/%s/quote", openOceanQuoteURL, chain.OpenOceanChain)

	params := url.Values{}
	params.Add("inTokenAddress", chain.TokenIn)
	params.Add("outTokenAddress", chain.TokenOut)
	params.Add("amount", chain.Amount)
	params.Add("gasPrice", "5")

	fullURL := fmt.Sprintf("%s?%s", endpoint, params.Encode())

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	startTime := time.Now()
	resp, err := quoteHTTPClient.Do(req)
	latencyMs := float64(time.Since(startTime).Milliseconds())

	if err != nil {
		return latencyMs, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	_, _ = io.ReadAll(resp.Body)

	return latencyMs, resp.StatusCode, nil
}

// ============================================================================
// ParaSwap API (Multi-chain, FREE)
// ============================================================================

func callParaSwapQuoteAPI(chain QuoteChainConfig) (float64, int, error) {
	params := url.Values{}
	params.Add("srcToken", chain.TokenIn)
	params.Add("destToken", chain.TokenOut)
	params.Add("amount", chain.Amount)
	params.Add("srcDecimals", fmt.Sprintf("%d", chain.Decimals))
	params.Add("destDecimals", "18") // Native tokens are 18 decimals
	params.Add("network", chain.ChainID)

	fullURL := fmt.Sprintf("%s?%s", paraSwapQuoteURL, params.Encode())

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	startTime := time.Now()
	resp, err := quoteHTTPClient.Do(req)
	latencyMs := float64(time.Since(startTime).Milliseconds())

	if err != nil {
		return latencyMs, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	_, _ = io.ReadAll(resp.Body)

	return latencyMs, resp.StatusCode, nil
}

// ============================================================================
// Li.Fi API (Multi-chain, FREE)
// ============================================================================

func callLifiQuoteAPI(chain QuoteChainConfig) (float64, int, error) {
	params := url.Values{}
	params.Add("fromChain", chain.ChainID)
	params.Add("toChain", chain.ChainID) // Same chain swap
	params.Add("fromToken", chain.TokenIn)
	params.Add("toToken", chain.TokenOut)
	params.Add("fromAmount", chain.Amount)
	params.Add("fromAddress", dummyWalletAddressEVM) // Required by Li.Fi

	fullURL := fmt.Sprintf("%s?%s", lifiQuoteURL, params.Encode())

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	startTime := time.Now()
	resp, err := quoteHTTPClient.Do(req)
	latencyMs := float64(time.Since(startTime).Milliseconds())

	if err != nil {
		return latencyMs, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	_, _ = io.ReadAll(resp.Body)

	return latencyMs, resp.StatusCode, nil
}

// ============================================================================
// KyberSwap API (Multi-chain, FREE)
// ============================================================================

func callKyberSwapQuoteAPI(chain QuoteChainConfig) (float64, int, error) {
	endpoint := fmt.Sprintf("%s/%s/api/v1/routes", kyberSwapQuoteURL, chain.KyberChainKey)

	params := url.Values{}
	params.Add("tokenIn", chain.TokenIn)
	params.Add("tokenOut", chain.TokenOut)
	params.Add("amountIn", chain.Amount)

	fullURL := fmt.Sprintf("%s?%s", endpoint, params.Encode())

	req, err := http.NewRequest("GET", fullURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	startTime := time.Now()
	resp, err := quoteHTTPClient.Do(req)
	latencyMs := float64(time.Since(startTime).Milliseconds())

	if err != nil {
		return latencyMs, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	_, _ = io.ReadAll(resp.Body)

	return latencyMs, resp.StatusCode, nil
}


// ============================================================================
// Main monitoring function
// ============================================================================

func performQuoteAPIChecks(config *Config) {
	timestamp := time.Now().UTC().Format("2006-01-02 15:04:05")

	fmt.Printf("\n[QUOTE-API][%s] === Starting quote API latency checks ===\n", timestamp)

	// ========== SOLANA QUOTES ==========

	// Mobula (Solana)
	latencyMs, statusCode, err := callMobulaSwapQuoteAPI(
		"solana",
		"solana",
		solanaConfig.TokenIn,
		solanaConfig.TokenOut,
		"100", // 100 USDC
		config.MobulaAPIKey,
	)
	if err != nil || statusCode >= 400 {
		RecordQuoteAPIError("mobula", "solana", getErrorType(statusCode), config.MonitorRegion)
		fmt.Printf("[QUOTE-API][%s][mobula][solana] %s | Latency: %.0fms | Status: %d\n",
			timestamp, getStatusEmoji(statusCode), latencyMs, statusCode)
	} else {
		RecordQuoteAPILatency("mobula", "solana", latencyMs, statusCode, config.MonitorRegion)
		fmt.Printf("[QUOTE-API][%s][mobula][solana] %s | Latency: %.0fms | Status: %d\n",
			timestamp, getStatusEmoji(statusCode), latencyMs, statusCode)
	}

	// Jupiter (Solana only - FREE public API)
	latencyMs, statusCode, err = callJupiterPublicQuoteAPI()
	if err != nil || statusCode >= 400 {
		RecordQuoteAPIError("jupiter", "solana", getErrorType(statusCode), config.MonitorRegion)
		fmt.Printf("[QUOTE-API][%s][jupiter][solana] %s | Latency: %.0fms | Status: %d\n",
			timestamp, getStatusEmoji(statusCode), latencyMs, statusCode)
	} else {
		RecordQuoteAPILatency("jupiter", "solana", latencyMs, statusCode, config.MonitorRegion)
		fmt.Printf("[QUOTE-API][%s][jupiter][solana] %s | Latency: %.0fms | Status: %d\n",
			timestamp, getStatusEmoji(statusCode), latencyMs, statusCode)
	}

	// ========== EVM QUOTES ==========

	// Test EVM chains with FREE APIs: Mobula (Base), OpenOcean, ParaSwap, Li.Fi, KyberSwap
	for _, chain := range evmQuoteChains {
		// Mobula (Base - chain where MobulaRouter is deployed)
		if chain.Name == "base" {
			latencyMs, statusCode, err := callMobulaSwapQuoteAPI(
				"evm:"+chain.ChainID,
				chain.Name,
				chain.TokenIn,
				chain.TokenOut,
				"100", // 100 USDC
				config.MobulaAPIKey,
			)
			if err != nil || statusCode >= 400 {
				RecordQuoteAPIError("mobula", chain.Name, getErrorType(statusCode), config.MonitorRegion)
				fmt.Printf("[QUOTE-API][%s][mobula][%s] %s | Latency: %.0fms | Status: %d\n",
					timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
			} else {
				RecordQuoteAPILatency("mobula", chain.Name, latencyMs, statusCode, config.MonitorRegion)
				fmt.Printf("[QUOTE-API][%s][mobula][%s] %s | Latency: %.0fms | Status: %d\n",
					timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
			}
		}

		// OpenOcean (FREE)
		latencyMs, statusCode, err := callOpenOceanQuoteAPI(chain)
		if err != nil || statusCode >= 400 {
			RecordQuoteAPIError("openocean", chain.Name, getErrorType(statusCode), config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][openocean][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		} else {
			RecordQuoteAPILatency("openocean", chain.Name, latencyMs, statusCode, config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][openocean][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		}

		// ParaSwap (FREE)
		latencyMs, statusCode, err = callParaSwapQuoteAPI(chain)
		if err != nil || statusCode >= 400 {
			RecordQuoteAPIError("paraswap", chain.Name, getErrorType(statusCode), config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][paraswap][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		} else {
			RecordQuoteAPILatency("paraswap", chain.Name, latencyMs, statusCode, config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][paraswap][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		}

		// Li.Fi (FREE)
		latencyMs, statusCode, err = callLifiQuoteAPI(chain)
		if err != nil || statusCode >= 400 {
			RecordQuoteAPIError("lifi", chain.Name, getErrorType(statusCode), config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][lifi][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		} else {
			RecordQuoteAPILatency("lifi", chain.Name, latencyMs, statusCode, config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][lifi][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		}

		// KyberSwap (FREE)
		latencyMs, statusCode, err = callKyberSwapQuoteAPI(chain)
		if err != nil || statusCode >= 400 {
			RecordQuoteAPIError("kyberswap", chain.Name, getErrorType(statusCode), config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][kyberswap][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		} else {
			RecordQuoteAPILatency("kyberswap", chain.Name, latencyMs, statusCode, config.MonitorRegion)
			fmt.Printf("[QUOTE-API][%s][kyberswap][%s] %s | Latency: %.0fms | Status: %d\n",
				timestamp, chain.Name, getStatusEmoji(statusCode), latencyMs, statusCode)
		}
	}

	// Jupiter (Solana) - Requires API key, skip if not available
	// TODO: Add JUPITER_API_KEY to config if needed
	// latencyMs, statusCode, err := callJupiterQuoteAPI("")
	// ...

	fmt.Printf("[QUOTE-API][%s] === Quote API checks completed ===\n\n", timestamp)
}

func getErrorType(statusCode int) string {
	if statusCode >= 500 {
		return "server_error"
	} else if statusCode >= 400 {
		return "client_error"
	} else if statusCode == 0 {
		return "timeout_error"
	}
	return "request_error"
}

func getStatusEmoji(statusCode int) string {
	if statusCode >= 400 {
		return "✗"
	} else if statusCode >= 300 {
		return "⚠"
	}
	return "✓"
}

// runQuoteAPIMonitor starts the quote API latency monitoring
func runQuoteAPIMonitor(config *Config, stopChan <-chan struct{}) {
	fmt.Println("Starting Quote API Latency Monitor...")
	fmt.Println("   Comparing: Mobula, Jupiter, OpenOcean, ParaSwap, Li.Fi, KyberSwap")
	fmt.Println("   Mobula: Solana + Base")
	fmt.Println("   Jupiter: Solana")
	fmt.Println("   Others: Ethereum, Base, BNB")
	fmt.Println("   Test: 100 USDC → Native token quote")
	fmt.Println("   Interval: 30 seconds")
	fmt.Println()

	// Create ticker for 30 second intervals
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Run once immediately
	performQuoteAPIChecks(config)

	// Then run every 30 seconds
	for {
		select {
		case <-stopChan:
			fmt.Println("Quote API monitor stopped")
			return
		case <-ticker.C:
			performQuoteAPIChecks(config)
		}
	}
}

// Helper to pretty print JSON for debugging
func prettyPrintJSON(data []byte) {
	var prettyJSON map[string]interface{}
	if err := json.Unmarshal(data, &prettyJSON); err == nil {
		formatted, _ := json.MarshalIndent(prettyJSON, "", "  ")
		fmt.Printf("%s\n", formatted)
	}
}
