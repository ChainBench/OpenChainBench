package main

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================================
// Head Lag Monitor
// Measures indexation latency: time between on-chain event and WebSocket receipt
// ============================================================================

// Post-reconnect grace period: Mobula WS replays buffered/old trades right
// after a (re)connect, which show up as multi-second "lag" that is NOT real
// indexation latency. During this window we do NOT feed the alerting gauges
// (mobula_head_lag_detailed_seconds & co) so #alerting-aggregator-latency
// stays quiet on reconnect bursts. The head_lag_seconds bench gauge keeps
// being fed (no spike alert on it; keeps AggregatorHeadLagStale happy).
const reconnectGracePeriod = 10 * time.Second

// Pool configurations for head lag monitoring
type HeadLagPool struct {
	Name       string // Human readable name
	Blockchain string // For Mobula: "evm:1", "solana", etc.
	NetworkID  int    // For Codex: 1, 1399811149, etc.
	Address    string // Pool address
	ChainName  string // Normalized chain name for metrics
}

// Pools to monitor - high activity pools for accurate lag measurement
var headLagPools = []HeadLagPool{
	{
		Name:       "SOL/USDC Raydium",
		Blockchain: "solana",
		NetworkID:  1399811149,
		Address:    "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm",
		ChainName:  "solana",
	},
	{
		// Uniswap V3 WETH/USDC 0.05% — high-activity native USDC pool.
		// Previous address 0x4c36…4b18 was WETH/USDbC (deprecated bridged
		// legacy USDC, ~17 swaps/hour, ~$27k liquidity) which routinely
		// went >5 min between trades and stalled AggregatorHeadLagStale
		// on chain="base" (2026-07-25 incident).
		Name:       "WETH/USDC Base",
		Blockchain: "evm:8453",
		NetworkID:  8453,
		Address:    "0xd0b53d9277642d899df5c87a3966a349a798f224",
		ChainName:  "base",
	},
	{
		// PancakeSwap V3 USDT/WBNB 0.01%, the pool geckoterminal_monitor.go
		// already reads. The WBNB/BUSD V2 pool this replaces went near-idle
		// after Binance stopped issuing BUSD: measured 2026-09-29 against
		// the chain, 1,248 swaps a day there, one every 69 s, against
		// 441,120 a day here.
		//
		// Two costs of leaving it behind, both measured over 24 h:
		// the flow watchdog below assumes a high-activity pool and takes a
		// silence past 10 minutes for a dead subscription, so it purged the
		// gauge and reconnected several times an hour — codex and
		// serialized, the only two monitors carrying that watchdog, sat at
		// 86 % presence on bnb while mobula and geckoterminal held 100 %;
		// and geckoterminal was reading a different pool from the other
		// three, so the bnb column compared head lags measured on two
		// different trade streams.
		Name:       "USDT/WBNB PancakeSwap V3",
		Blockchain: "evm:56",
		NetworkID:  56,
		Address:    "0x172fcd41e0913e95784454622d1c3724f546f849",
		ChainName:  "bnb",
	},
	{
		// Highest txn-frequency pool on Robinhood Chain (~40k swaps/24h).
		Name:       "USDG/WETH Robinhood",
		Blockchain: "evm:4663",
		NetworkID:  4663,
		Address:    "0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a",
		ChainName:  "robinhood",
	},
}

// ============================================================================
// Mobula WebSocket Monitor
// ============================================================================

type MobulaTradeEvent struct {
	Blockchain string  `json:"blockchain"`
	Date       int64   `json:"date"`      // On-chain timestamp (ms)
	Timestamp  int64   `json:"timestamp"` // When Mobula processed it (ms)
	Hash       string  `json:"hash"`
	Pair       string  `json:"pair"`
	Type       string  `json:"type"`
	TokenPrice float64 `json:"tokenPrice"`
}

func runMobulaHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()

	if config.MobulaAPIKey == "" {
		fmt.Println("[HEAD-LAG][MOBULA] API key not set, skipping")
		return
	}

	fmt.Println("[HEAD-LAG][MOBULA] Starting WebSocket monitor...")

	reconnectDelay := 5 * time.Second
	maxReconnectDelay := 60 * time.Second

	for {
		select {
		case <-stopChan:
			fmt.Println("[HEAD-LAG][MOBULA] Monitor stopped")
			return
		default:
			err := connectAndMonitorMobula(config, stopChan)
			RecordWSConnected("mobula", config.MonitorRegion, false)
			if err != nil {
				RecordWSReconnect("mobula", config.MonitorRegion)
				log.Printf("[HEAD-LAG][MOBULA] 🔌 DISCONNECTED: %v. Reconnecting in %v...", err, reconnectDelay)

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
				// Reset delay on clean disconnect
				reconnectDelay = 5 * time.Second
			}
		}
	}
}

func connectAndMonitorMobula(config *Config, stopChan <-chan struct{}) error {
	// Use direct connection for Mobula (no proxy needed, avoids latency spikes)
	dialer := &websocket.Dialer{}
	conn, _, err := dialer.Dial(config.MobulaWSURL, nil)
	if err != nil {
		return fmt.Errorf("dial failed: %w", err)
	}
	defer conn.Close()

	// Build subscription items
	var items []map[string]interface{}
	for _, pool := range headLagPools {
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

	connectedAt := time.Now()
	RecordWSConnected("mobula", config.MonitorRegion, true)
	log.Printf("[HEAD-LAG][MOBULA] ✅ CONNECTED — subscribed to %d pools (alert-gauge grace period: %v)", len(items), reconnectGracePeriod)

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
			var trade MobulaTradeEvent
			if err := json.Unmarshal(message, &trade); err != nil {
				continue
			}

			// Skip non-trade messages (pong, etc)
			if trade.Hash == "" || trade.Date == 0 {
				continue
			}

			// Calculate head lag
			receiveTime := time.Now().UTC()
			onChainTime := time.UnixMilli(trade.Date)
			mobulaProcessTime := time.UnixMilli(trade.Timestamp)

			// Total lag: on-chain → WebSocket receipt
			totalLagMs := receiveTime.Sub(onChainTime).Milliseconds()

			// Reference lag: same trade, but timed against the node
			// subscription we hold ourselves rather than against the
			// timestamp Mobula sent us. Recorded before the legacy
			// filter below so a preconfirmed emission is counted rather
			// than dropped. See reference_monitor.go.

			// Drop WebSocket replays / clock-skew events: not real indexation latency
			// (Mobula WS occasionally replays old trades on reconnect; those would otherwise fire alerts)
			if totalLagMs < 0 || totalLagMs > 30000 {
				continue
			}

			// Mobula processing latency: on-chain → Mobula processed
			mobulaLagMs := mobulaProcessTime.Sub(onChainTime).Milliseconds()

			// Network latency: Mobula processed → WebSocket receipt
			networkLagMs := receiveTime.Sub(mobulaProcessTime).Milliseconds()

			lagSeconds := float64(totalLagMs) / 1000.0

			// Get chain name from pool config
			chainName := getChainNameFromBlockchain(trade.Blockchain)

			// Record basic metric (deferred reference match, see pending_match.go)
			emitHeadLag("mobula", chainName, config.MonitorRegion, trade.Hash, receiveTime, totalLagMs, lagSeconds)

			// Track latest tx per pool so alert annotations can link to it
			RecordMobulaLastTx(chainName, config.MonitorRegion, trade.Pair, trade.Hash)

			// Post-reconnect grace: don't feed the alerting gauges with
			// replayed/buffered trades from the fresh connection.
			if time.Since(connectedAt) < reconnectGracePeriod {
				if totalLagMs > 2000 {
					log.Printf("[HEAD-LAG][MOBULA][%s] ⏭️  GRACE: late trade %.2fs within %v of reconnect — alert gauge NOT updated | Tx: %s",
						chainName, lagSeconds, reconnectGracePeriod, trade.Hash)
				}
			} else {
				// Record detailed metric with breakdown
				RecordMobulaHeadLagDetailed(
					chainName,
					config.MonitorRegion,
					trade.Pair,
					trade.Hash,
					totalLagMs,
					mobulaLagMs,
					networkLagMs,
					onChainTime.Format("2006-01-02T15:04:05Z"),
					mobulaProcessTime.Format("2006-01-02T15:04:05Z"),
					receiveTime.Format("2006-01-02T15:04:05Z"),
				)
			}

			// Enhanced logging for spikes
			if totalLagMs > 3000 {
				timestamp := receiveTime.Format("15:04:05")
				fmt.Printf("[HEAD-LAG][MOBULA][%s][%s] 🚨 SPIKE DETECTED!\n", timestamp, chainName)
				fmt.Printf("  Total Lag: %.2fs (%.0fms)\n", lagSeconds, float64(totalLagMs))
				fmt.Printf("  ├─ Mobula Processing: %.0fms (on-chain → Mobula)\n", float64(mobulaLagMs))
				fmt.Printf("  └─ Network Latency: %.0fms (Mobula → WebSocket)\n", float64(networkLagMs))
				fmt.Printf("  On-chain: %s | Mobula: %s | Received: %s\n",
					onChainTime.Format("15:04:05.000"),
					mobulaProcessTime.Format("15:04:05.000"),
					receiveTime.Format("15:04:05.000"))
				fmt.Printf("  Tx: %s\n", trade.Hash)
			} else if time.Now().Second()%30 == 0 {
				// Log normal latency occasionally
				timestamp := receiveTime.Format("15:04:05")
				fmt.Printf("[HEAD-LAG][MOBULA][%s][%s] Lag: %.2fs | Tx: %s\n",
					timestamp, chainName, lagSeconds, trade.Hash[:12]+"...")
			}
		}
	}
}

func getChainNameFromBlockchain(blockchain string) string {
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

// ============================================================================
// Codex WebSocket Monitor (API key)
// ============================================================================

// Standard Codex endpoint, used for every chain except Solana. Solana reads
// from Codex's edge node instead (Config.CodexSolanaWSURL).
const codexWSURL = "wss://graph.codex.io/graphql"

// codexSockets folds the Codex connections into the one ws_connected
// series the spec reads: 1 only while every socket is up, so a dropped
// Solana edge socket is not hidden by a healthy one for the other chains.
type codexSockets struct {
	mu     sync.Mutex
	region string
	up     map[string]bool
}

func newCodexSockets(region string, names ...string) *codexSockets {
	s := &codexSockets{region: region, up: make(map[string]bool)}
	for _, name := range names {
		s.up[name] = false
	}
	return s
}

func (s *codexSockets) set(name string, connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.up[name] = connected
	all := true
	for _, up := range s.up {
		all = all && up
	}
	RecordWSConnected("codex", s.region, all)
}

type CodexWSMessage struct {
	Type    string                 `json:"type"`
	ID      string                 `json:"id,omitempty"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

type CodexEventData struct {
	Data struct {
		OnEventsCreated *struct {
			Address   string `json:"address"`
			NetworkID int    `json:"networkId"`
			Events    []struct {
				BlockNumber     int64  `json:"blockNumber"`
				Timestamp       int64  `json:"timestamp"`
				TransactionHash string `json:"transactionHash"`
				EventType       string `json:"eventType"`
			} `json:"events"`
		} `json:"onEventsCreated,omitempty"`
		OnUnconfirmedEventsCreated *struct {
			Address   string `json:"address"`
			NetworkID int    `json:"networkId"`
			Events    []struct {
				BlockNumber     int64  `json:"blockNumber"`
				Timestamp       int64  `json:"timestamp"`
				TransactionHash string `json:"transactionHash"`
				EventType       string `json:"eventType"`
			} `json:"events"`
		} `json:"onUnconfirmedEventsCreated,omitempty"`
	} `json:"data"`
}

func runCodexHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()

	if config.CodexAPIKey == "" {
		fmt.Println("[HEAD-LAG][CODEX] CODEX_API_KEY not set — monitor disabled")
		return
	}

	// Solana reads from Codex's edge node; every other chain stays on the
	// standard endpoint. One socket each, both on the same API key.
	var edgePools, graphPools []HeadLagPool
	for _, pool := range headLagPools {
		if pool.ChainName == "solana" {
			edgePools = append(edgePools, pool)
		} else {
			graphPools = append(graphPools, pool)
		}
	}
	fmt.Printf("[HEAD-LAG][CODEX] Starting WebSocket monitor (Solana: %s, others: %s)...\n", config.CodexSolanaWSURL, codexWSURL)

	sockets := newCodexSockets(config.MonitorRegion, "edge", "graph")
	var connections sync.WaitGroup
	connections.Add(2)
	go func() {
		defer connections.Done()
		runCodexSocket(config, stopChan, sockets, "edge", config.CodexSolanaWSURL, edgePools)
	}()
	go func() {
		defer connections.Done()
		runCodexSocket(config, stopChan, sockets, "graph", codexWSURL, graphPools)
	}()
	connections.Wait()
}

// runCodexSocket holds one Codex connection open for a set of pools,
// reconnecting with backoff until stopChan closes.
func runCodexSocket(config *Config, stopChan <-chan struct{}, sockets *codexSockets, name, endpoint string, pools []HeadLagPool) {
	tag := fmt.Sprintf("[HEAD-LAG][CODEX][%s]", name)

	// Backoff strategy:
	// - 10s base delay, doubling on consecutive net errors, capped at 60s
	// - 30s flat on auth or rate-limit errors (a bad key will not fix itself
	//   faster than that, and hammering the endpoint does not help)
	const baseDelay = 10 * time.Second
	const maxReconnectDelay = 60 * time.Second

	reconnectDelay := baseDelay
	consecutiveFailures := 0
	attemptNum := 0

	for {
		select {
		case <-stopChan:
			fmt.Printf("%s Monitor stopped\n", tag)
			return
		default:
			attemptNum++
			log.Printf("%s 🔄 Connection attempt #%d", tag, attemptNum)

			err := connectAndMonitorCodex(config, stopChan, sockets, tag, name, endpoint, pools)
			sockets.set(name, false)
			if err != nil {
				RecordWSReconnect("codex", config.MonitorRegion)
				consecutiveFailures++
				log.Printf("%s ❌ Connection attempt #%d failed (%d consecutive): %v", tag, attemptNum, consecutiveFailures, err)

				if strings.Contains(err.Error(), "429") || strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "4401") || strings.Contains(err.Error(), "4403") {
					log.Printf("%s 🔑 Auth or rate-limit error, check CODEX_API_KEY; retrying in 30s", tag)
					reconnectDelay = 30 * time.Second
				} else {
					// Net/IO error: exponential backoff, capped at 60s.
					reconnectDelay *= 2
					if reconnectDelay < baseDelay {
						reconnectDelay = baseDelay
					}
					if reconnectDelay > maxReconnectDelay {
						reconnectDelay = maxReconnectDelay
					}
				}

				log.Printf("%s ⏳ Reconnecting in %v... (next attempt: #%d)", tag, reconnectDelay, attemptNum+1)
				select {
				case <-stopChan:
					return
				case <-time.After(reconnectDelay):
				}
			} else {
				log.Printf("%s ✅ Connection closed cleanly after attempt #%d", tag, attemptNum)
				reconnectDelay = baseDelay
				consecutiveFailures = 0
				attemptNum = 0
			}
		}
	}
}

func connectAndMonitorCodex(config *Config, stopChan <-chan struct{}, sockets *codexSockets, tag, name, endpoint string, pools []HeadLagPool) error {
	dialer := &websocket.Dialer{
		Subprotocols:     []string{"graphql-transport-ws"},
		HandshakeTimeout: 30 * time.Second,
	}

	log.Printf("%s Step 1/2: Connecting to %s...", tag, endpoint)
	conn, resp, err := dialer.Dial(endpoint, nil)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("dial failed (HTTP %d): %w", resp.StatusCode, err)
		}
		return fmt.Errorf("dial failed: %w", err)
	}
	defer conn.Close()

	// Codex takes the raw API key, no "Bearer" prefix.
	log.Printf("%s Step 2/2: Sending connection_init...", tag)
	initMsg := map[string]interface{}{
		"type": "connection_init",
		"payload": map[string]interface{}{
			"Authorization": config.CodexAPIKey,
		},
	}
	if err := conn.WriteJSON(initMsg); err != nil {
		return fmt.Errorf("init failed: %w", err)
	}

	// Wait for ack
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("ack read failed: %w", err)
	}

	var ackMsg CodexWSMessage
	if err := json.Unmarshal(msg, &ackMsg); err != nil || ackMsg.Type != "connection_ack" {
		return fmt.Errorf("unexpected ack: %s", string(msg))
	}
	log.Printf("%s Step 2/2: ✅ Received connection_ack", tag)

	log.Printf("%s Subscribing to %d pools...", tag, len(pools))
	for i, pool := range pools {
		subID := fmt.Sprintf("headlag_%d", i)

		var subMsg map[string]interface{}

		// Solana and Base: commitmentLevel Processed. On Solana that is the
		// pre-confirmation stage (it replaced onUnconfirmedEventsCreated,
		// deprecated by Codex on 2026-04-20); on Base it is the flashblock
		// preconfirmation, the same stage the Base reference clock reads.
		// Verified delivering with an API key on both endpoints 2026-10-20.
		// Do not assume other EVM networks support this level.
		if pool.ChainName == "solana" || pool.ChainName == "base" {
			poolID := fmt.Sprintf("%s:%d", pool.Address, pool.NetworkID)
			subMsg = map[string]interface{}{
				"type": "subscribe",
				"id":   subID,
				"payload": map[string]interface{}{
					"query": `subscription OnPoolEvents($id: String!, $cl: [EventCommitmentLevel!]) {
						onEventsCreated(id: $id, commitmentLevel: $cl) {
							address
							networkId
							events {
								blockNumber
								timestamp
								transactionHash
								eventType
							}
						}
					}`,
					"variables": map[string]interface{}{
						"id": poolID,
						"cl": []string{"Processed"},
					},
				},
			}
		} else {
			// Other EVM chains: default commitment (confirmed events)
			subMsg = map[string]interface{}{
				"type": "subscribe",
				"id":   subID,
				"payload": map[string]interface{}{
					"query": `subscription OnPoolEvents($address: String!, $networkId: Int!) {
						onEventsCreated(address: $address, networkId: $networkId) {
							address
							networkId
							events {
								blockNumber
								timestamp
								transactionHash
								eventType
							}
						}
					}`,
					"variables": map[string]interface{}{
						"address":   pool.Address,
						"networkId": pool.NetworkID,
					},
				},
			}
		}

		if err := conn.WriteJSON(subMsg); err != nil {
			return fmt.Errorf("subscribe to %s failed: %w", pool.Name, err)
		}

		time.Sleep(100 * time.Millisecond) // Small delay between subscriptions
	}

	log.Printf("%s ✅ Subscribed to %d pools", tag, len(pools))
	log.Printf("%s 🎉 Connection fully established! Waiting for events...", tag)
	sockets.set(name, true)

	// graphql-transport-ws keepalive: send {"type":"ping"} every 20s.
	// Without this, Codex (or a hop in between) silently kills idle
	// TCP after ~3min, manifesting as "i/o timeout" or "1006 unexpected EOF".
	// Writes to the websocket conn are serialized via writeMu since we now have
	// two goroutines writing (this ping loop + the subscribe path on next reconnect).
	var writeMu sync.Mutex

	// Per-chain flow watchdog. A high-activity pool that goes silent for
	// 10 minutes means the subscription is dead even if the connection
	// looks healthy (pongs + other subs satisfy the read deadline). On
	// trip: purge the frozen gauges for that chain so the bench page
	// never shows a stale value, then force a reconnect by closing the
	// connection (the read loop errors out and the outer loop redials).
	var lastEventMu sync.Mutex
	lastEventByChain := make(map[string]time.Time)
	firstEventBySub := make(map[string]bool)
	for _, pool := range pools {
		lastEventByChain[pool.ChainName] = time.Now()
	}
	const flowSilence = 10 * time.Minute
	watchdogDone := make(chan struct{})
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-watchdogDone:
				return
			case <-t.C:
				lastEventMu.Lock()
				tripped := ""
				for chain, last := range lastEventByChain {
					if time.Since(last) > flowSilence {
						tripped = chain
						break
					}
				}
				lastEventMu.Unlock()
				if tripped != "" {
					log.Printf("%s 🪦 %s subscription silent for >%s — purging gauges and forcing reconnect", tag, tripped, flowSilence)
					DeleteHeadLagSeries("codex", tripped, config.MonitorRegion)
					_ = conn.Close()
					return
				}
			}
		}
	}()
	defer close(watchdogDone)

	pingDone := make(chan struct{})
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-pingDone:
				return
			case <-t.C:
				writeMu.Lock()
				err := conn.WriteJSON(map[string]string{"type": "ping"})
				writeMu.Unlock()
				if err != nil {
					return // read loop will see the failure too and exit cleanly
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
			// 90s deadline: longer than ping interval so a single missed pong doesn't
			// kill us, but short enough to fail fast if the server actually went away.
			conn.SetReadDeadline(time.Now().Add(90 * time.Second))
			_, message, err := conn.ReadMessage()
			if err != nil {
				return fmt.Errorf("read failed: %w", err)
			}

			// Parse message
			var wsMsg CodexWSMessage
			if err := json.Unmarshal(message, &wsMsg); err != nil {
				continue
			}

			// graphql-transport-ws keepalive: server may push ping; reply pong.
			// Server may also push pong in response to our ping — silently consume.
			if wsMsg.Type == "ping" {
				writeMu.Lock()
				_ = conn.WriteJSON(map[string]string{"type": "pong"})
				writeMu.Unlock()
				continue
			}
			if wsMsg.Type == "pong" {
				continue
			}

			// graphql-transport-ws: the server terminates ONE subscription
			// with {"type":"complete","id":...} or {"type":"error",...}.
			// Swallowing these (the pre-2026-07-09 behaviour) leaves a dead
			// subscription on a live connection: no read timeout (other
			// subs keep the socket busy), frozen gauges, blind alerts.
			// Codex killed the Solana sub exactly this way. Force a full
			// reconnect + resubscribe instead.
			if wsMsg.Type == "complete" || wsMsg.Type == "error" {
				return fmt.Errorf("subscription %q terminated by server (type=%s)", wsMsg.ID, wsMsg.Type)
			}

			// Skip non-data messages
			if wsMsg.Type != "next" || wsMsg.Payload == nil {
				continue
			}

			// One-shot log per subscription id: tells us whether the legacy
			// unconfirmed sub, the Processed sub, or both deliver on this tier.
			if !firstEventBySub[wsMsg.ID] {
				firstEventBySub[wsMsg.ID] = true
				log.Printf("%s 📬 First event on subscription %q", tag, wsMsg.ID)
			}

			// Parse event data
			payloadBytes, _ := json.Marshal(wsMsg.Payload)
			var eventData CodexEventData
			if err := json.Unmarshal(payloadBytes, &eventData); err != nil {
				continue
			}

			// Handle both onEventsCreated and onUnconfirmedEventsCreated
			var events []struct {
				BlockNumber     int64  `json:"blockNumber"`
				Timestamp       int64  `json:"timestamp"`
				TransactionHash string `json:"transactionHash"`
				EventType       string `json:"eventType"`
			}
			var networkID int

			if eventData.Data.OnEventsCreated != nil {
				events = eventData.Data.OnEventsCreated.Events
				networkID = eventData.Data.OnEventsCreated.NetworkID
			} else if eventData.Data.OnUnconfirmedEventsCreated != nil {
				events = eventData.Data.OnUnconfirmedEventsCreated.Events
				networkID = eventData.Data.OnUnconfirmedEventsCreated.NetworkID
			}

			if len(events) == 0 {
				continue
			}

			for _, event := range events {
				if event.EventType != "Swap" || event.TransactionHash == "" {
					continue
				}

				// Calculate head lag
				receiveTime := time.Now().UTC()
				onChainTime := time.Unix(event.Timestamp, 0)
				lagMs := receiveTime.Sub(onChainTime).Milliseconds()
				lagSeconds := float64(lagMs) / 1000.0

				// Get chain name
				chainName := getChainNameFromNetworkID(networkID)

				// Reference lag against our own node subscription, matched
				// by transaction hash. See reference_monitor.go.

				lastEventMu.Lock()
				lastEventByChain[chainName] = time.Now()
				lastEventMu.Unlock()

				// Record metrics with tx hash
				emitHeadLag("codex", chainName, config.MonitorRegion, event.TransactionHash, receiveTime, lagMs, lagSeconds)
				RecordCodexBlockNumber(chainName, event.BlockNumber, config.MonitorRegion)

				// Enhanced logging for spikes
				if lagMs > 3000 {
					timestamp := receiveTime.Format("15:04:05")
					fmt.Printf("[HEAD-LAG][CODEX][%s][%s] 🚨 SPIKE DETECTED!\n", timestamp, chainName)
					fmt.Printf("  Total Lag: %.2fs (%.0fms)\n", lagSeconds, float64(lagMs))
					fmt.Printf("  On-chain: %s | Received: %s\n",
						onChainTime.Format("15:04:05.000"),
						receiveTime.Format("15:04:05.000"))
					fmt.Printf("  Block: %d | Tx: %s\n", event.BlockNumber, event.TransactionHash)
				} else if time.Now().Second()%30 == 0 {
					// Log normal latency occasionally
					timestamp := receiveTime.Format("15:04:05")
					fmt.Printf("[HEAD-LAG][CODEX][%s][%s] Lag: %.2fs | Block: %d | Tx: %s\n",
						timestamp, chainName, lagSeconds, event.BlockNumber, event.TransactionHash[:12]+"...")
				}
			}
		}
	}
}

func getChainNameFromNetworkID(networkID int) string {
	switch networkID {
	case 1:
		return "ethereum"
	case 1399811149:
		return "solana"
	case 8453:
		return "base"
	case 56:
		return "bnb"
	case 4663:
		return "robinhood"
	default:
		return fmt.Sprintf("network_%d", networkID)
	}
}

// ============================================================================
// Main Head Lag Monitor
// ============================================================================

func runHeadLagMonitor(config *Config, stopChan <-chan struct{}) {
	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║              HEAD LAG MONITOR (WebSocket-based)              ║")
	fmt.Println("╠══════════════════════════════════════════════════════════════╣")
	fmt.Println("║  Measures: Time between on-chain event and WebSocket receipt ║")
	fmt.Println("║  Providers: Mobula + Pulse + Codex + GeckoTerminal           ║")
	fmt.Printf("║  Pools: %d high-activity pools across 3 chains               ║\n", len(headLagPools))
	fmt.Printf("║  Region: %s                                                   ║\n", config.MonitorRegion)
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	fmt.Println()

	var wg sync.WaitGroup

	// Start Mobula fast-trade monitor
	wg.Add(1)
	// The reference clock must be up before the provider monitors, so the
	// first emissions have something to match against. It is never fatal:
	// a chain with no endpoint simply leaves the ref series empty.
	runReferenceMonitor(stopChan)
	// Base only: the sealed-block observation above is too late to be the
	// zero point there. See base_flashblock_ref.go. Started before the
	// providers for the same reason.
	go runBaseFlashblockReference(stopChan)
	// Resolves provider emissions against the reference once it catches up,
	// so a reference that arrives after a fast provider is still matched.
	go runPendingResolver(stopChan)

	go runMobulaHeadLagMonitor(config, stopChan, &wg)

	// Start Codex monitor
	wg.Add(1)
	go runCodexHeadLagMonitor(config, stopChan, &wg)

	// Start GeckoTerminal monitor
	wg.Add(1)
	go runGeckoTerminalHeadLagMonitor(config, stopChan, &wg)

	// Start Serialized monitor. Disabled cleanly when the key is unset.
	wg.Add(1)
	go runSerializedHeadLagMonitor(config, stopChan, &wg)

	// Start OKX monitor. Base and Solana only, and token-scoped upstream:
	// see the header of okx_head_lag_monitor.go for both reasons.
	wg.Add(1)
	go runOKXHeadLagMonitor(config, stopChan, &wg)

	// Start Birdeye monitor. Same shape as OKX: Base and Solana, token-scoped,
	// and its dial needs a User-Agent or the edge answers 403.
	wg.Add(1)
	go runBirdeyeHeadLagMonitor(config, stopChan, &wg)

	// Wait for all to finish
	wg.Wait()
	fmt.Println("[HEAD-LAG] All monitors stopped")
}
