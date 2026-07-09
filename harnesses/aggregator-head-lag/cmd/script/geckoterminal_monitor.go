package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================================
// GeckoTerminal WebSocket Monitor
// ============================================================================

const (
	geckoWSURL     = "wss://cables.geckoterminal.com/cable"
	geckoOrigin    = "https://www.geckoterminal.com"
	geckoUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
)

// GeckoTerminal pools (pool_id extracted via reverse engineering)
var geckoTerminalPools = []struct {
	Name    string
	Network string
	PoolID  string
	Chain   string
}{
	{
		Name:    "SOL/USDC Raydium",
		Network: "solana",
		PoolID:  "162715608",
		Chain:   "solana",
	},
	{
		Name:    "WETH/USDC Base",
		Network: "base",
		PoolID:  "162840764",
		Chain:   "base",
	},
	{
		// PancakeSwap V3 USDT/WBNB 0.01% — $130M+ 24h volume. Replaces the
		// former WBNB/BUSD PancakeSwap V2 pool (pool_id "24") that went
		// near-idle after Binance stopped issuing new BUSD in 2024,
		// causing the head_lag alertmanager rule to fire on stale
		// samples every few hours.
		// Pool address: 0x172fcd41e0913e95784454622d1c3724f546f849
		// Internal GT pool_id source: app.geckoterminal.com/api/p1/bsc/pools/<address>
		Name:    "USDT/WBNB PancakeSwap V3",
		Network: "bsc",
		PoolID:  "160787671",
		Chain:   "bnb",
	},
	{
		// Highest txn-frequency pool on Robinhood Chain (~40k swaps/24h).
		// Internal GT pool_id source: app.geckoterminal.com/api/p1/robinhood/pools/<address>
		// Pool address: 0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a
		Name:    "USDG/WETH Robinhood",
		Network: "robinhood",
		PoolID:  "328167634",
		Chain:   "robinhood",
	},
}

// ActionCable message structures
type GeckoActionCableMessage struct {
	Type       string          `json:"type,omitempty"`
	Command    string          `json:"command,omitempty"`
	Identifier string          `json:"identifier,omitempty"`
	Message    json.RawMessage `json:"message,omitempty"`
}

type GeckoChannelIdentifier struct {
	Channel string `json:"channel"`
	PoolID  string `json:"pool_id,omitempty"`
}

// Swap data from SwapChannel
type GeckoSwapData struct {
	Data struct {
		BlockTimestamp int64  `json:"block_timestamp"` // On-chain timestamp (ms)
		TxHash         string `json:"tx_hash"`
		// Other fields available but not needed for head lag
	} `json:"data"`
	Type string `json:"type"` // "newSwap"
}

func runGeckoTerminalHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()

	fmt.Println("[HEAD-LAG][GECKO] Starting WebSocket monitor...")

	reconnectDelay := 5 * time.Second
	maxReconnectDelay := 60 * time.Second

	for {
		select {
		case <-stopChan:
			fmt.Println("[HEAD-LAG][GECKO] Monitor stopped")
			return
		default:
			err := connectAndMonitorGecko(config, stopChan)
			if err != nil {
				log.Printf("[HEAD-LAG][GECKO] Connection error: %v. Reconnecting in %v...", err, reconnectDelay)

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

func connectAndMonitorGecko(config *Config, stopChan <-chan struct{}) error {
	headers := map[string][]string{
		"Origin":     {geckoOrigin},
		"User-Agent": {geckoUserAgent},
	}

	conn, _, err := getProxyDialer().Dial(geckoWSURL, headers)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}
	defer conn.Close()

	// Channel for messages
	done := make(chan struct{})

	// Read messages goroutine
	go func() {
		defer close(done)
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				return
			}

			handleGeckoMessage(config, conn, message)
		}
	}()

	// Wait for welcome message
	time.Sleep(2 * time.Second)

	// Subscribe to SwapChannel for all monitored pools
	for _, pool := range geckoTerminalPools {
		subscribeToGeckoSwapChannel(conn, pool.PoolID, pool.Name)
		time.Sleep(100 * time.Millisecond)
	}

	fmt.Printf("[HEAD-LAG][GECKO] Subscribed to %d pools\n", len(geckoTerminalPools))

	// Heartbeat ticker
	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()

	// Read messages
	for {
		select {
		case <-stopChan:
			return nil
		case <-done:
			return fmt.Errorf("connection closed by server")
		case <-pingTicker.C:
			// Server sends pings, we respond with pongs (handled in handleGeckoMessage)
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		}
	}
}

func handleGeckoMessage(config *Config, conn *websocket.Conn, message []byte) {
	var msg GeckoActionCableMessage
	if err := json.Unmarshal(message, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "welcome":
		// Connection established

	case "ping":
		// Respond to ping with pong
		pong := GeckoActionCableMessage{
			Type: "pong",
		}
		conn.WriteJSON(pong)

	case "confirm_subscription":
		// Subscription confirmed

	case "reject_subscription":
		log.Printf("[HEAD-LAG][GECKO] Subscription rejected: %s", msg.Identifier)

	default:
		// Handle data messages
		if msg.Message != nil {
			handleGeckoDataMessage(config, msg.Identifier, msg.Message)
		}
	}
}

func handleGeckoDataMessage(config *Config, identifier string, message json.RawMessage) {
	// Parse swap data
	var swapData GeckoSwapData
	if err := json.Unmarshal(message, &swapData); err != nil {
		return
	}

	if swapData.Type != "newSwap" {
		return
	}

	// Extract channel info to get pool
	var channelIdent GeckoChannelIdentifier
	if err := json.Unmarshal([]byte(identifier), &channelIdent); err != nil {
		return
	}

	// Find which pool this is
	var poolChain string
	for _, pool := range geckoTerminalPools {
		if pool.PoolID == channelIdent.PoolID {
			poolChain = pool.Chain
			break
		}
	}

	if poolChain == "" {
		return
	}

	// Calculate head lag
	receiveTime := time.Now().UTC()
	onChainTime := time.UnixMilli(swapData.Data.BlockTimestamp)
	lagMs := receiveTime.Sub(onChainTime).Milliseconds()
	lagSeconds := float64(lagMs) / 1000.0

	// Record metrics with tx hash
	RecordHeadLag("geckoterminal", poolChain, lagMs, lagSeconds, config.MonitorRegion, swapData.Data.TxHash)

	// Log occasionally (not every trade)
	if lagMs > 10000 || time.Now().Second()%30 == 0 {
		timestamp := receiveTime.Format("15:04:05")
		txHash := swapData.Data.TxHash
		if len(txHash) > 12 {
			txHash = txHash[:10] + "..."
		}
		fmt.Printf("[HEAD-LAG][GECKO][%s][%s] Lag: %.2fs | Tx: %s\n",
			timestamp, poolChain, lagSeconds, txHash)
	}
}

func subscribeToGeckoSwapChannel(conn *websocket.Conn, poolID, poolName string) {
	identifier := GeckoChannelIdentifier{
		Channel: "SwapChannel",
		PoolID:  poolID,
	}

	identifierJSON, _ := json.Marshal(identifier)

	subscribeMsg := GeckoActionCableMessage{
		Command:    "subscribe",
		Identifier: string(identifierJSON),
	}

	if err := conn.WriteJSON(subscribeMsg); err != nil {
		log.Printf("[HEAD-LAG][GECKO] Error subscribing to %s: %v", poolName, err)
		return
	}
}
