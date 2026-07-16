package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Persistent WebSocket machinery, ported from the l2-block-time
// harness. One goroutine per (provider, chain) endpoint:
//
//   - dial with timeout, subscribe, read loop with rolling deadline
//   - client ping every 30s; pong handler extends the read deadline
//   - head watchdog: the pong handler keeps the read deadline alive, so
//     a provider that heartbeats while silently dropping the
//     subscription (observed on publicnode) would wedge the goroutine
//     forever. If no head/slot arrives for headWatchdog, slam the
//     connection closed and let the outer loop redial.
//   - reconnect with exponential backoff 2s → 60s; per-connection, so a
//     dead endpoint (e.g. drpc/base if delisted) degrades to health=0 +
//     periodic redials without touching the rest of the cohort.

const (
	dialTimeout  = 15 * time.Second
	readDeadline = 60 * time.Second
	pingEvery    = 30 * time.Second
	minBackoff   = 2 * time.Second
	maxBackoff   = 60 * time.Second
	// headWatchdog must sit well above the slowest cadence in the panel
	// (ethereum, 12s slots; solana pushes multiple times per second).
	// 90s of silence is unambiguously a broken subscription.
	headWatchdog = 90 * time.Second
)

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

// evmEnvelope matches both the eth_subscription push frame and the
// subscribe ack.
type evmEnvelope struct {
	Method string `json:"method"`
	Params *struct {
		Result json.RawMessage `json:"result"`
	} `json:"params,omitempty"`
}

type evmHead struct {
	Number string `json:"number"`
	Hash   string `json:"hash"`
}

// StartEndpoints spawns the reconnect loop for every configured
// (provider, chain) connection.
func StartEndpoints() {
	for _, ep := range endpoints() {
		ep := ep
		go func() {
			backoff := minBackoff
			for {
				start := time.Now()
				var err error
				switch ep.Kind {
				case "solana":
					err = runSolanaConn(ep)
				default:
					err = runEVMConn(ep)
				}
				wsHealth.WithLabelValues(ep.Provider, ep.Chain).Set(0)
				wsReconnects.WithLabelValues(ep.Provider, ep.Chain).Inc()
				if err != nil {
					fmt.Printf("[%s/%s] WS error: %v (reconnecting in %v)\n", ep.Provider, ep.Chain, err, backoff)
				}
				// A connection that held for a while earns a fresh
				// backoff; only consecutive fast failures escalate.
				if time.Since(start) > 5*time.Minute {
					backoff = minBackoff
				}
				time.Sleep(backoff)
				if backoff < maxBackoff {
					backoff *= 2
					if backoff > maxBackoff {
						backoff = maxBackoff
					}
				}
			}
		}()
	}
}

// dialAndGuard opens the connection and installs ping + watchdog
// goroutines shared by the EVM and Solana read loops. The returned
// cleanup must be deferred; bumpHead must be called on every accepted
// head/slot.
func dialAndGuard(ep Endpoint) (conn *websocket.Conn, bumpHead func(), cleanup func(), err error) {
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = dialTimeout
	conn, _, err = dialer.Dial(ep.URL, nil)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("dial: %w", err)
	}

	done := make(chan struct{})
	var lastHeadUnixNano atomic.Int64
	lastHeadUnixNano.Store(time.Now().UnixNano())

	go func() {
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			}
		}
	}()
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case now := <-t.C:
				silent := now.Sub(time.Unix(0, lastHeadUnixNano.Load()))
				if silent > headWatchdog {
					fmt.Printf("[%s/%s] watchdog: no event for %s, forcing reconnect\n", ep.Provider, ep.Chain, silent.Round(time.Second))
					_ = conn.Close()
					return
				}
			}
		}
	}()

	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(readDeadline))
		return nil
	})

	bumpHead = func() { lastHeadUnixNano.Store(time.Now().UnixNano()) }
	cleanup = func() {
		close(done)
		_ = conn.Close()
	}
	return conn, bumpHead, cleanup, nil
}

func runEVMConn(ep Endpoint) error {
	conn, bumpHead, cleanup, err := dialAndGuard(ep)
	if err != nil {
		return err
	}
	defer cleanup()

	if err := conn.WriteJSON(rpcReq{
		JSONRPC: "2.0", ID: 1, Method: "eth_subscribe",
		Params: []any{"newHeads"},
	}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	wsHealth.WithLabelValues(ep.Provider, ep.Chain).Set(1)
	fmt.Printf("[%s/%s] connected, subscribed to newHeads\n", ep.Provider, ep.Chain)

	agg := aggregatorFor(ep.Chain)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(readDeadline))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var env evmEnvelope
		if err := json.Unmarshal(msg, &env); err != nil {
			continue
		}
		if env.Method != "eth_subscription" || env.Params == nil {
			continue // subscribe ack or unrelated frame
		}
		var head evmHead
		if err := json.Unmarshal(env.Params.Result, &head); err != nil {
			continue
		}
		blockNum := parseHexInt64(head.Number)
		if blockNum == 0 {
			continue
		}
		now := time.Now()
		bumpHead()
		wsHealth.WithLabelValues(ep.Provider, ep.Chain).Set(1)
		agg.record(ep.Provider, blockNum, now)
	}
}

func parseHexInt64(s string) int64 {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return 0
	}
	n, _ := strconv.ParseInt(s, 16, 64)
	return n
}
