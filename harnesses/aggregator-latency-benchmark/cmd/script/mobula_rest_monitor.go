package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

const (
	mobulaRESTBaseURL = "https://api.mobula.io"
)

// Chains for REST monitoring - aligned with all monitors
var mobulaRESTChains = []struct {
	blockchain   string
	blockchainID string
	chainName    string
	poolAddress  string
}{
	{"Solana", "solana", "solana", "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"},      // SOL/USDC
	{"Base", "8453", "base", "0x4c36388be6f416a29c8d8eee81c771ce6be14b18"},              // WETH/USDC Base
	{"BSC", "56", "bnb", "0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16"},                  // WBNB/BUSD PancakeSwap
}

type MobulaMarketDataResponse struct {
	Data []struct {
		Volume float64 `json:"volume"`
		Open   float64 `json:"open"`
		High   float64 `json:"high"`
		Low    float64 `json:"low"`
		Close  float64 `json:"close"`
		Time   int64   `json:"time"`
	} `json:"data"`
}

// callMobulaMarketDataAPI makes a REST call to Mobula's market history/pair endpoint
func callMobulaMarketDataAPI(apiKey string, poolAddress string, blockchain string, chainName string) (float64, int, error) {
	endpoint := fmt.Sprintf("%s/api/1/market/history/pair", mobulaRESTBaseURL)

	// Create HTTP client with timeout
	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	// Build request
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create request: %w", err)
	}

	// Add query parameters
	// Get last 1 hour of data with 1 minute candles
	to := time.Now().UnixMilli()
	from := time.Now().Add(-1 * time.Hour).UnixMilli()

	q := req.URL.Query()
	q.Add("address", poolAddress)
	q.Add("blockchain", blockchain)
	q.Add("period", "1min")
	q.Add("from", fmt.Sprintf("%d", from))
	q.Add("to", fmt.Sprintf("%d", to))
	q.Add("amount", "5") // Just get 5 candles, we don't care about data
	req.URL.RawQuery = q.Encode()

	// Add headers
	req.Header.Set("Authorization", apiKey)
	req.Header.Set("Content-Type", "application/json")

	// Measure latency
	startTime := time.Now()
	resp, err := client.Do(req)
	latencyMs := float64(time.Since(startTime).Milliseconds())

	if err != nil {
		return latencyMs, 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response body for debugging
	body, _ := io.ReadAll(resp.Body)

	// Try to parse response
	var marketData MobulaMarketDataResponse
	if err := json.Unmarshal(body, &marketData); err != nil {
		// Not a critical error, we still measured latency
		log.Printf("[MOBULA-REST][%s] Response parse warning: %v (status: %d)", chainName, err, resp.StatusCode)
	}

	return latencyMs, resp.StatusCode, nil
}

// monitorMobulaREST continuously monitors Mobula REST API latency
func monitorMobulaREST(config *Config, stopChan <-chan struct{}) {
	fmt.Println("Starting Mobula REST API monitor...")
	fmt.Printf("   Monitoring %d chains with 20s interval\n", len(mobulaRESTChains))
	fmt.Printf("   Endpoint: /api/1/market/history/pair\n")
	fmt.Println()

	if config.MobulaAPIKey == "" {
		fmt.Println("MOBULA_API_KEY not set in .env file. Skipping Mobula REST monitor.")
		return
	}

	// Create ticker for 20 second intervals
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	// Run once immediately
	performMobulaRESTChecks(config)

	// Then run every 20 seconds
	for {
		select {
		case <-stopChan:
			fmt.Println("Mobula REST monitor stopped")
			return
		case <-ticker.C:
			performMobulaRESTChecks(config)
		}
	}
}

// performMobulaRESTChecks performs REST API calls to all chains
func performMobulaRESTChecks(config *Config) {
	timestamp := time.Now().UTC().Format("2006-01-02 15:04:05")

	for _, chain := range mobulaRESTChains {
		latencyMs, statusCode, err := callMobulaMarketDataAPI(
			config.MobulaAPIKey,
			chain.poolAddress,
			chain.blockchainID,
			chain.chainName,
		)

		if err != nil {
			// Record error
			errorType := "request_error"
			if statusCode >= 500 {
				errorType = "server_error"
			} else if statusCode >= 400 {
				errorType = "client_error"
			} else if statusCode == 0 {
				errorType = "timeout_error"
			}

			RecordRESTError("mobula", "market_data", chain.chainName, errorType, config.MonitorRegion)

			fmt.Printf("[MOBULA-REST][%s][%s] ERROR | Latency: %.0fms | Status: %d | Error: %v\n",
				timestamp,
				chain.chainName,
				latencyMs,
				statusCode,
				err,
			)
			continue
		}

		// Record successful latency measurement
		RecordRESTLatency("mobula", "market_data", chain.chainName, latencyMs, statusCode, config.MonitorRegion)

		// Log the result
		statusEmoji := "✓"
		if statusCode >= 400 {
			statusEmoji = "✗"
		} else if statusCode >= 300 {
			statusEmoji = "⚠"
		}

		fmt.Printf("[MOBULA-REST][%s][%s] %s | Latency: %.0fms | Status: %d\n",
			timestamp,
			chain.chainName,
			statusEmoji,
			latencyMs,
			statusCode,
		)
	}
}

// runMobulaRESTMonitor is the entry point for the Mobula REST monitor
func runMobulaRESTMonitor(config *Config, stopChan <-chan struct{}) {
	monitorMobulaREST(config, stopChan)
}
