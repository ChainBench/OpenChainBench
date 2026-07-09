package main

import (
	"encoding/json"
	"fmt"
	"time"

	_ "github.com/gorilla/websocket" // Used by proxy.go getProxyDialer
)

// ============================================================================
// Mobula Fast-Trade Monitor (separate from head lag)
// Monitors fast-trade latency for comparison with Pulse V2
// ============================================================================

type MobulaFastTradeEvent struct {
	Blockchain string  `json:"blockchain"`
	Date       int64   `json:"date"`      // On-chain timestamp (ms)
	Timestamp  int64   `json:"timestamp"` // Mobula processing timestamp (ms)
	Hash       string  `json:"hash"`
	Pair       string  `json:"pair"`
	Address    string  `json:"address"` // Pool address
	Type       string  `json:"type"`
	TokenPrice float64 `json:"tokenPrice"`
}

// Monitored pools (same chains as Pulse V2)
var fastTradePools = []struct {
	Blockchain string
	Address    string
	ChainName  string
}{
	{
		Blockchain: "solana",
		Address:    "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm", // SOL/USDC Raydium
		ChainName:  "solana",
	},
	{
		Blockchain: "evm:8453",
		Address:    "0x4c36388be6f416a29c8d8eee81c771ce6be14b18", // WETH/USDC Base
		ChainName:  "base",
	},
	{
		Blockchain: "evm:56",
		Address:    "0x58f876857a02d6762e0101bb5c46a8c1ed44dc16", // WBNB/BUSD PancakeSwap
		ChainName:  "bnb",
	},
	{
		Blockchain: "evm:4663",
		Address:    "0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a", // USDG/WETH Robinhood
		ChainName:  "robinhood",
	},
}

func runMobulaFastTradeMonitor(config *Config, stopChan <-chan struct{}) {
	fmt.Println()
	fmt.Println("╔═══════════════════════════════════════════════════════════╗")
	fmt.Println("║         MOBULA FAST-TRADE MONITOR (Comparison)            ║")
	fmt.Println("╠═══════════════════════════════════════════════════════════╣")
	fmt.Println("║  Purpose: Compare with Pulse V2 discovery latency         ║")
	fmt.Println("║  Monitoring: High-volume pools on 4 chains                ║")
	fmt.Printf("║  Pools: %d monitored pools                                 ║\n", len(fastTradePools))
	fmt.Println("╚═══════════════════════════════════════════════════════════╝")
	fmt.Println()

	if config.MobulaAPIKey == "" {
		fmt.Println("[FAST-TRADE][MOBULA] API key not set, skipping")
		return
	}

	reconnectDelay := 5 * time.Second
	maxReconnectDelay := 60 * time.Second

	for {
		select {
		case <-stopChan:
			fmt.Println("[FAST-TRADE][MOBULA] Monitor stopped")
			return
		default:
			err := connectAndMonitorFastTrade(config, stopChan)
			if err != nil {
				fmt.Printf("[FAST-TRADE][MOBULA] Connection error: %v. Reconnecting in %v...\n", err, reconnectDelay)

				select {
				case <-stopChan:
					return
				case <-time.After(reconnectDelay):
					reconnectDelay = reconnectDelay * 2
					if reconnectDelay > maxReconnectDelay {
						reconnectDelay = maxReconnectDelay
					}
				}
			} else {
				reconnectDelay = 5 * time.Second
			}
		}
	}
}

func connectAndMonitorFastTrade(config *Config, stopChan <-chan struct{}) error {
	conn, _, err := getProxyDialer().Dial(config.MobulaWSURL, nil)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}
	defer conn.Close()

	// Build subscription items
	var items []map[string]interface{}
	for _, pool := range fastTradePools {
		items = append(items, map[string]interface{}{
			"blockchain": pool.Blockchain,
			"address":    pool.Address,
		})
	}

	// Subscribe to fast-trade
	subscribeMsg := map[string]interface{}{
		"type":          "fast-trade",
		"authorization": config.MobulaAPIKey,
		"payload": map[string]interface{}{
			"assetMode": false,
			"items":     items,
		},
	}

	if err := conn.WriteJSON(subscribeMsg); err != nil {
		return fmt.Errorf("subscribe failed: %w", err)
	}

	fmt.Printf("[FAST-TRADE][MOBULA] Subscribed to %d pools\n", len(items))

	// Start ping goroutine
	pingDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-pingDone:
				return
			case <-ticker.C:
				if err := conn.WriteJSON(map[string]string{"event": "ping"}); err != nil {
					return
				}
			}
		}
	}()
	defer close(pingDone)

	// Read messages
	for {
		select {
		case <-stopChan:
			return nil
		default:
			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			_, message, err := conn.ReadMessage()
			if err != nil {
				return fmt.Errorf("read failed: %w", err)
			}

			// Parse message
			var trade MobulaFastTradeEvent
			if err := json.Unmarshal(message, &trade); err != nil {
				continue
			}

			// Skip non-trade messages (pong, etc)
			if trade.Hash == "" || trade.Date == 0 {
				continue
			}

			// Calculate fast-trade latency
			receiveTime := time.Now().UTC()
			onChainTime := time.UnixMilli(trade.Date)
			mobulaProcessTime := time.UnixMilli(trade.Timestamp)

			// Total latency: on-chain → WebSocket receipt
			totalLagMs := receiveTime.Sub(onChainTime).Milliseconds()

			// Mobula processing latency: on-chain → Mobula processed
			mobulaLagMs := mobulaProcessTime.Sub(onChainTime).Milliseconds()

			// Network latency: Mobula processed → WebSocket receipt
			networkLagMs := receiveTime.Sub(mobulaProcessTime).Milliseconds()

			lagSeconds := float64(totalLagMs) / 1000.0

			// Get chain name
			chainName := getChainNameFromBlockchainFastTrade(trade.Blockchain)

			// Record metric with "fast-trade" source label
			RecordFastTradeLatency("mobula", chainName, float64(totalLagMs), config.MonitorRegion)

			// Enhanced logging for spikes
			if totalLagMs > 3000 {
				timestamp := receiveTime.Format("15:04:05")
				fmt.Printf("[FAST-TRADE][MOBULA][%s][%s] 🚨 SPIKE DETECTED!\n", timestamp, chainName)
				fmt.Printf("  Total Latency: %.2fs (%.0fms)\n", lagSeconds, float64(totalLagMs))
				fmt.Printf("  ├─ Mobula Processing: %.0fms (on-chain → Mobula)\n", float64(mobulaLagMs))
				fmt.Printf("  └─ Network Latency: %.0fms (Mobula → WebSocket)\n", float64(networkLagMs))
				fmt.Printf("  Tx: %s\n", trade.Hash)
				fmt.Printf("  Pool: %s\n", trade.Address)
				fmt.Printf("  On-chain time: %s\n", onChainTime.Format("15:04:05.000"))
				fmt.Printf("  Mobula processed: %s\n", mobulaProcessTime.Format("15:04:05.000"))
				fmt.Printf("  Received: %s\n", receiveTime.Format("15:04:05.000"))
			} else if time.Now().Second()%30 == 0 {
				// Log normal latency occasionally
				timestamp := receiveTime.Format("15:04:05")
				fmt.Printf("[FAST-TRADE][MOBULA][%s][%s] Latency: %.2fs | Tx: %s\n",
					timestamp, chainName, lagSeconds, trade.Hash[:12]+"...")
			}
		}
	}
}

func getChainNameFromBlockchainFastTrade(blockchain string) string {
	switch blockchain {
	case "Ethereum", "evm:1":
		return "ethereum"
	case "Solana", "solana":
		return "solana"
	case "Base", "evm:8453":
		return "base"
	case "BNB Smart Chain (BEP20)", "BSC", "evm:56":
		return "bnb"
	case "Robinhood Chain", "evm:4663":
		return "robinhood"
	default:
		return blockchain
	}
}
