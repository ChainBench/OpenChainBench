package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Serialized head-lag monitor.
//
// Serialized streams trades over one WebSocket, keyed by TOKEN with an
// optional pool filter. That shape matters for this bench, which is keyed
// by POOL: subscribing by the pool's native/wrapped side (SOL, WETH, WBNB)
// acknowledges and then delivers nothing, because Serialized treats the
// chain native as a quote asset and never as a token (their REST surface
// 404s on So111...112 the same way). Subscribing by the pool's `token`
// side as reported by their own GET /v1/pool, with `pools=<pool>`,
// delivers the tape for exactly that market. Verified before shipping on
// all four bench pools: base 10, bnb 2, robinhood 79 events with txHash
// in 90 s. So the token address is resolved from /v1/pool at startup and
// falls back to a pinned map only if that call fails.
//
// One connection per process, all pools multiplexed as subscriptions:
// Serialized caps a key at 5 concurrent connections, and this harness
// runs in three regions off one key.
//
// Lag is recorded twice, on purpose. `head_lag_seconds` uses the
// provider's own `at`, exactly like the Mobula and Codex paths, so
// Serialized gets the same treatment as the incumbents on the legacy
// series (including its filter that drops negatives). `head_lag_ref_
// seconds` uses the node reference clock matched by txHash, which is the
// series that can actually compare providers. See reference_monitor.go.
// The endpoint is Config.SerializedWSURL (SERIALIZED_WS_URL).

const (
	serializedPingEvery    = 10 * time.Second
	serializedReadDeadline = 20 * time.Second // two missed pongs
	// serializedSlowLog is the lag above which a trade is logged one by
	// one, hash and both clocks, so a spike can be checked tx by tx
	// against Serialized's own send logs.
	serializedSlowLog = 3 * time.Second
	serializedSeenMax = 20000
)

// serializedPinnedToken is the fallback when /v1/pool is unreachable at
// boot. Values are the `token` side of each bench pool as Serialized
// reports it (2026-09-06).
var serializedPinnedToken = map[string]string{
	"solana":    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
	"base":      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",   // USDC
	"bnb":       "0x55d398326f99059ff775485246999027b3197955",   // USDT
	"robinhood": "0x5fc5360d040013d5cba0d1de2a9c7e6c4c16b83c",   // USDG (best effort; runtime resolve preferred)
}

type serializedStreamEvent struct {
	Op      string `json:"op"`
	ID      string `json:"id"`
	Channel string `json:"channel"`
	Error   *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
	Data *struct {
		TxHash       string `json:"txHash"`
		ID           string `json:"id"`
		At           int64  `json:"at"`
		Block        int64  `json:"block"`
		Preconfirmed bool   `json:"preconfirmed"`
		PoolAddress  string `json:"poolAddress"`
	} `json:"data,omitempty"`
}

// serializedResolveToken asks Serialized which side of the pool it treats
// as the token. Their /v1/pool is free (0 credits).
func serializedResolveToken(apiKey string, pool HeadLagPool) string {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET",
		fmt.Sprintf("https://api.serialized.xyz/v1/pool?chain=%s&address=%s", pool.Blockchain, pool.Address), nil)
	if err == nil {
		req.Header.Set("Authorization", apiKey)
		req.Header.Set("Accept", "application/json")
		if resp, err := client.Do(req); err == nil {
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			var out struct {
				Data struct {
					Token struct {
						Address string `json:"address"`
					} `json:"token"`
				} `json:"data"`
			}
			if resp.StatusCode == 200 && json.Unmarshal(body, &out) == nil && out.Data.Token.Address != "" {
				return out.Data.Token.Address
			}
		}
	}
	return serializedPinnedToken[pool.ChainName]
}

func runSerializedHeadLagMonitor(config *Config, stopChan <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()

	if config.SerializedAPIKey == "" {
		fmt.Println("[HEAD-LAG][SERIALIZED] SERIALIZED_API_KEY not set — monitor disabled")
		RecordWSConnected("serialized", config.MonitorRegion, false)
		return
	}
	fmt.Println("[HEAD-LAG][SERIALIZED] Starting WebSocket monitor...")

	// pool address (lowercased) -> chain name, for events that carry a
	// poolAddress we did not subscribe to (should not happen with the
	// pools filter, but a misrouted event must never be scored on the
	// wrong chain).
	poolChain := map[string]string{}
	tokens := map[string]string{}
	for _, p := range headLagPools {
		poolChain[strings.ToLower(p.Address)] = p.ChainName
		tokens[p.ChainName] = serializedResolveToken(config.SerializedAPIKey, p)
		fmt.Printf("[HEAD-LAG][SERIALIZED] %s: token side %s for pool %s\n", p.ChainName, tokens[p.ChainName], p.Address)
	}

	const baseDelay = 5 * time.Second
	const maxDelay = 60 * time.Second
	const healthySession = 2 * time.Minute
	delay := baseDelay
	attempt := 0

	for {
		select {
		case <-stopChan:
			return
		default:
		}
		attempt++
		started := time.Now()
		err := serializedConnectAndStream(config, tokens, poolChain, stopChan)
		RecordWSConnected("serialized", config.MonitorRegion, false)
		// A session that streamed for a while ended on its own; the backoff
		// is for consecutive failures. Without this reset every drop after
		// the fifth waited the 60 s ceiling, a minute of missing trades
		// charged to the provider for an ordinary disconnect.
		if time.Since(started) > healthySession {
			delay = baseDelay
		}
		if err != nil {
			RecordWSReconnect("serialized", config.MonitorRegion)
			log.Printf("[HEAD-LAG][SERIALIZED] ❌ attempt #%d ended: %v — reconnect in %v", attempt, err, delay)
			msg := err.Error()
			switch {
			case strings.Contains(msg, "4401"):
				log.Printf("[HEAD-LAG][SERIALIZED] 🔑 auth rejected (4401): key missing, invalid or revoked")
				delay = maxDelay
			case strings.Contains(msg, "4402"):
				log.Printf("[HEAD-LAG][SERIALIZED] 💳 monthly quota exhausted (4402)")
				delay = maxDelay
			case strings.Contains(msg, "connection limit"):
				log.Printf("[HEAD-LAG][SERIALIZED] 🚦 5-connections-per-key cap hit: another process is holding sockets on this key")
				delay = maxDelay
			default:
				delay *= 2
				if delay > maxDelay {
					delay = maxDelay
				}
			}
		} else {
			delay = baseDelay
		}
		select {
		case <-stopChan:
			return
		case <-time.After(delay):
		}
	}
}

func serializedConnectAndStream(config *Config, tokens map[string]string, poolChain map[string]string, stopChan <-chan struct{}) error {
	// Plain dialer, not getProxyDialer: the scraping proxy is only for
	// Defined.fi and would add its own latency to this feed.
	dialer := &websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.Dial(config.SerializedWSURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	var writeMu sync.Mutex
	send := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(v)
	}

	// Auth must be the first frame within 10 s.
	if err := send(map[string]string{"op": "auth", "apiKey": config.SerializedAPIKey}); err != nil {
		return fmt.Errorf("auth send: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("auth read: %w", err)
	}
	var ack serializedStreamEvent
	if json.Unmarshal(raw, &ack) != nil || ack.Op != "auth.ok" {
		return fmt.Errorf("auth not acknowledged: %s", strings.TrimSpace(string(raw)))
	}

	subscribed := 0
	for _, p := range headLagPools {
		tok := tokens[p.ChainName]
		if tok == "" {
			log.Printf("[HEAD-LAG][SERIALIZED] %s: no token side known for pool %s — skipped", p.ChainName, p.Address)
			continue
		}
		if err := send(map[string]any{
			"op": "subscribe", "channel": "trades", "id": p.ChainName,
			"params": map[string]string{"chain": p.Blockchain, "address": tok, "pools": p.Address},
		}); err != nil {
			return fmt.Errorf("subscribe %s: %w", p.ChainName, err)
		}
		subscribed++
	}
	if subscribed == 0 {
		return fmt.Errorf("no pool could be subscribed")
	}
	RecordWSConnected("serialized", config.MonitorRegion, true)
	fmt.Printf("[HEAD-LAG][SERIALIZED] ✅ connected, %d pool subscriptions sent\n", subscribed)

	// Keepalive: {"op":"ping"} every serializedPingEvery; the pongs keep
	// the read deadline moving. The server closes idle sockets at 60 s,
	// but the bench has to notice a stalled path far sooner: with a 90 s
	// deadline a socket that froze and then resumed handed over its whole
	// backlog at once, scored as 60-118 s of lag on 2026-10-14 in us-east
	// while the other feeds, which redial within seconds, read 1-3 s.
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(serializedPingEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-stopChan:
				return
			case <-t.C:
				if err := send(map[string]string{"op": "ping"}); err != nil {
					return
				}
			}
		}
	}()

	// Per-chain flow watchdog, same policy as the Codex path: a bench pool
	// silent for 10 min means the subscription is dead even if pongs keep
	// the socket alive. Purge the gauge so the page never shows a frozen
	// value, then force a redial.
	var lastMu sync.Mutex
	lastEvent := map[string]time.Time{}
	for _, p := range headLagPools {
		lastEvent[p.ChainName] = time.Now()
	}
	const flowSilence = 10 * time.Minute
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				lastMu.Lock()
				tripped := ""
				for chain, last := range lastEvent {
					if time.Since(last) > flowSilence {
						tripped = chain
						break
					}
				}
				lastMu.Unlock()
				if tripped != "" {
					log.Printf("[HEAD-LAG][SERIALIZED] 🪦 %s silent for >%s — purging gauge and forcing reconnect", tripped, flowSilence)
					DeleteHeadLagSeries("serialized", tripped, config.MonitorRegion)
					_ = conn.Close()
					return
				}
			}
		}
	}()

	// Deliveries already scored, by trade id, bounded FIFO. Per connection:
	// a replay after a reconnect is filtered by the race and the 120 s cap.
	seen := map[string]time.Time{}
	var seenOrder []string
	for {
		select {
		case <-stopChan:
			return nil
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(serializedReadDeadline))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		receiveTime := time.Now().UTC()

		var ev serializedStreamEvent
		if json.Unmarshal(raw, &ev) != nil {
			continue
		}
		switch ev.Op {
		case "pong", "subscribed", "auth.ok":
			continue
		case "error":
			if ev.Error != nil {
				log.Printf("[HEAD-LAG][SERIALIZED] ⚠️ stream error on %q: %s %s", ev.ID, ev.Error.Code, ev.Error.Message)
			}
			continue
		case "event":
		default:
			continue
		}
		if ev.Data == nil {
			continue
		}
		d := ev.Data
		txHash := d.TxHash
		if txHash == "" && d.ID != "" {
			// Older events carry the hash only inside id as "<hash>:<idx>".
			txHash = strings.SplitN(d.ID, ":", 2)[0]
		}
		if txHash == "" || d.At == 0 {
			continue
		}

		chainName := ev.ID
		if c, ok := poolChain[strings.ToLower(d.PoolAddress)]; ok && d.PoolAddress != "" {
			chainName = c
		}
		if chainName == "" {
			continue
		}

		lastMu.Lock()
		lastEvent[chainName] = time.Now()
		lastMu.Unlock()

		lagSeconds := receiveTime.Sub(time.UnixMilli(d.At)).Seconds()

		// A trade delivered twice (same id, or same hash when id is
		// missing) is logged and dropped: scored again it would read as
		// one trade arriving minutes late.
		key := chainName + "|" + d.ID
		if d.ID == "" {
			key = chainName + "|" + txHash
		}
		if first, ok := seen[key]; ok {
			log.Printf("[HEAD-LAG][SERIALIZED] 🔁 duplicate %s on %s: first received %s, again %s (+%.1fs), at=%s",
				key, chainName, first.Format("15:04:05.000"), receiveTime.Format("15:04:05.000"),
				receiveTime.Sub(first).Seconds(), time.UnixMilli(d.At).UTC().Format("15:04:05.000"))
			continue
		}
		seen[key] = receiveTime
		seenOrder = append(seenOrder, key)
		if len(seenOrder) > serializedSeenMax {
			delete(seen, seenOrder[0])
			seenOrder = seenOrder[1:]
		}
		if lagSeconds > serializedSlowLog.Seconds() {
			log.Printf("[HEAD-LAG][SERIALIZED] 🐢 slow %s on %s: at=%s received=%s lag %.2fs (block %d)",
				txHash, chainName, time.UnixMilli(d.At).UTC().Format("15:04:05.000"),
				receiveTime.Format("15:04:05.000"), lagSeconds, d.Block)
		}

		// Legacy series: provider's own clock, identical treatment to the
		// incumbents (RecordHeadLag drops negatives and >120 s itself).
		emitHeadLag("serialized", chainName, config.MonitorRegion, txHash, receiveTime, 0, lagSeconds)

		// Reference series: our node clock, matched by hash.
		if d.Preconfirmed {
			// Flashblocks preconfirmation on Base. Kept visible in the log;
			// the ref series counts it under ahead_of_reference when it lands
			// before our node sees the block.
			log.Printf("[HEAD-LAG][SERIALIZED] ⚡ preconfirmed trade %s on %s (lag %.3fs vs own clock)", txHash[:10], chainName, lagSeconds)
		}
	}
}
