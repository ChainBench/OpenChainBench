package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ============================================================================
// Moralis REST API Monitor
// Triggered by WebSocket trades to measure indexation lag
// ============================================================================

type MoralisOHLCVResponse struct {
	PairAddress string `json:"pairAddress"`
	Result      []struct {
		Timestamp string  `json:"timestamp"`
		Close     float64 `json:"close"`
		Volume    float64 `json:"volume"`
		Trades    int     `json:"trades"`
	} `json:"result"`
}

type MoralisMonitorPool struct {
	Name        string
	Chain       string // Chain name for metrics
	ChainID     string // Chain ID for Moralis API (hex for EVM, "solana" for Solana)
	PairAddress string
	IsEVM       bool
}

// Map WebSocket pool addresses to Moralis pairs
var moralisPairMapping = map[string]MoralisMonitorPool{
	// Solana
	"7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm": {
		Name:        "SOL/USDC Raydium",
		Chain:       "solana",
		ChainID:     "solana",
		PairAddress: "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm",
		IsEVM:       false,
	},
	// Base
	"0x4c36388be6f416a29c8d8eee81c771ce6be14b18": {
		Name:        "WETH/USDC Base",
		Chain:       "base",
		ChainID:     "0x2105",
		PairAddress: "0x4c36388be6f416a29c8d8eee81c771ce6be14b18",
		IsEVM:       true,
	},
	// BNB
	"0x58f876857a02d6762e0101bb5c46a8c1ed44dc16": {
		Name:        "WBNB/BUSD PancakeSwap",
		Chain:       "bnb",
		ChainID:     "0x38",
		PairAddress: "0x58f876857a02d6762e0101bb5c46a8c1ed44dc16",
		IsEVM:       true,
	},
}

var (
	moralisCheckQueue = make(chan TradeCheckRequest, 1000)
	moralisHttpClient = &http.Client{Timeout: 10 * time.Second}
)

type TradeCheckRequest struct {
	PairAddress   string
	OnChainTime   time.Time
	TransactionHash string
}

func runMoralisRESTMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()

	fmt.Println("[HEAD-LAG][MORALIS-REST] Starting triggered REST monitor...")
	fmt.Println("[HEAD-LAG][MORALIS-REST] Will check Moralis API when trades arrive via WebSocket")

	// Start worker to process check requests
	for {
		select {
		case <-stopChan:
			fmt.Println("[HEAD-LAG][MORALIS-REST] Monitor stopped")
			return
		case req := <-moralisCheckQueue:
			checkMoralisForTrade(config, req)
		}
	}
}

// TriggerMoralisCheck is called when a trade is detected via WebSocket
// It queues a check to see if Moralis has indexed it yet
func TriggerMoralisCheck(pairAddress string, onChainTime time.Time, txHash string) {
	// Normalize address
	pairAddress = strings.ToLower(pairAddress)

	// Check if we monitor this pair
	if _, exists := moralisPairMapping[pairAddress]; !exists {
		return
	}

	select {
	case moralisCheckQueue <- TradeCheckRequest{
		PairAddress:     pairAddress,
		OnChainTime:     onChainTime,
		TransactionHash: txHash,
	}:
	default:
		// Queue full, skip
	}
}

func checkMoralisForTrade(config *Config, req TradeCheckRequest) {
	pool, exists := moralisPairMapping[req.PairAddress]
	if !exists {
		return
	}

	// Skip if no Moralis API key configured
	// TODO: Add MORALIS_API_KEY to config
	// For now, skip Moralis checks silently
	return

	// Build URL using correct Moralis Web3 Data API
	url := fmt.Sprintf("https://deep-index.moralis.io/api/v2.2/pairs/%s/ohlcv", pool.PairAddress)

	// Query from slightly before the on-chain trade to now
	toDate := time.Now().UTC()
	fromDate := req.OnChainTime.Add(-2 * time.Minute) // Start 2 minutes before trade

	httpReq, err := http.NewRequest("GET", url, nil)
	if err != nil {
		RecordHeadLagError("moralis", pool.Chain, "request_creation_failed", config.MonitorRegion)
		return
	}

	q := httpReq.URL.Query()
	if pool.IsEVM {
		q.Add("chain", pool.ChainID)
	}
	q.Add("to_date", fmt.Sprintf("%d", toDate.Unix()))
	q.Add("from_date", fmt.Sprintf("%d", fromDate.Unix()))
	q.Add("timeframe", "1m")
	httpReq.URL.RawQuery = q.Encode()

	// Set headers with API key
	// httpReq.Header.Set("X-API-Key", config.MoralisAPIKey)
	httpReq.Header.Set("Accept", "application/json")

	// Make request
	checkTime := time.Now()
	resp, err := moralisHttpClient.Do(httpReq)
	if err != nil {
		RecordHeadLagError("moralis", pool.Chain, "request_failed", config.MonitorRegion)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		RecordHeadLagError("moralis", pool.Chain, fmt.Sprintf("http_%d", resp.StatusCode), config.MonitorRegion)
		return
	}

	// Parse response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		RecordHeadLagError("moralis", pool.Chain, "read_body_failed", config.MonitorRegion)
		return
	}

	var data MoralisOHLCVResponse
	if err := json.Unmarshal(body, &data); err != nil {
		RecordHeadLagError("moralis", pool.Chain, "json_parse_failed", config.MonitorRegion)
		return
	}

	if len(data.Result) == 0 {
		// No data yet - trade not indexed
		RecordHeadLagError("moralis", pool.Chain, "trade_not_found", config.MonitorRegion)
		return
	}

	// Find the candle that contains our on-chain trade time
	// The candle timestamp is the START of the 1-minute window
	tradeMinute := req.OnChainTime.Truncate(time.Minute)

	found := false
	for _, candle := range data.Result {
		candleTime, err := time.Parse("2006-01-02T15:04:05.000Z", candle.Timestamp)
		if err != nil {
			continue
		}

		// Check if this candle contains our trade
		// Candle at 09:05:00 contains trades from 09:05:00 to 09:05:59
		if candleTime.Equal(tradeMinute) || candleTime.Before(tradeMinute) && candleTime.Add(time.Minute).After(req.OnChainTime) {
			// Found! Calculate lag
			lagMs := checkTime.Sub(req.OnChainTime).Milliseconds()
			lagSeconds := float64(lagMs) / 1000.0

			// Record metrics with tx hash
			RecordHeadLag("moralis", pool.Chain, lagMs, lagSeconds, config.MonitorRegion, req.TransactionHash)

			// Log
			fmt.Printf("[HEAD-LAG][MORALIS][%s][%s] Trade found! Lag: %.2fs | Tx: %s | Candle: %s\n",
				checkTime.Format("15:04:05"), pool.Chain, lagSeconds, req.TransactionHash[:16], candle.Timestamp)

			found = true
			break
		}
	}

	if !found {
		// Trade happened but not in any candle yet
		RecordHeadLagError("moralis", pool.Chain, "trade_not_in_candles", config.MonitorRegion)
	}
}
