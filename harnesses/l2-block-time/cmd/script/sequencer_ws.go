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

// Each L2Chain gets one persistent WebSocket subscription to
// `newHeads`. When a new head arrives, we record `now - lastSeen` as
// the block-time sample for that chain. On disconnect we reconnect
// with exponential backoff.
//
// The metric measured (block-time) is intentionally raw wall-clock,
// not the chain's protocol-claimed block interval. This is the right
// signal for "how often does my sequencer actually produce a block?",
// which captures real-world batching, idle gaps, and producer hiccups
// that nominal block-time numbers ("Base: 2s") hide.

const (
	dialTimeout    = 15 * time.Second
	readDeadline   = 60 * time.Second
	pingEvery      = 30 * time.Second
	minBackoff     = 2 * time.Second
	maxBackoff     = 60 * time.Second
	// Sanity bound — never emit a single sample larger than this. Drops
	// the natural outlier of a reconnect gap from polluting p50.
	maxSampleMs    = 5 * 60 * 1000 // 5 min
	// Max time without receiving a newHead event before we force a
	// reconnect. Important because the pong handler bumps SetReadDeadline,
	// so a provider that keeps sending pongs but silently drops our
	// subscription (observed on publicnode → scroll: 0 reconnects in 1h
	// while samples_total stuck at 23,887) wedges the goroutine forever.
	// All L2s in the panel have block-time < 15s, so 90s of silence is
	// unambiguously broken.
	headWatchdog   = 90 * time.Second
)

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

// rpcEnvelope handles BOTH:
//
//	{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"0x..","result":{...}}}
//
// and the subscription ack response:
//
//	{"jsonrpc":"2.0","id":1,"result":"0x..."}
type rpcEnvelope struct {
	Method string          `json:"method"`
	Params *struct{
		Result json.RawMessage `json:"result"`
	} `json:"params,omitempty"`
}

type newHead struct {
	Number    string `json:"number"`
	Timestamp string `json:"timestamp"`
}

// StartSequencerWS spawns one goroutine per L2. Each goroutine runs
// runChain in a reconnect loop forever.
func StartSequencerWS() {
	for _, ch := range l2Chains() {
		ch := ch
		go func() {
			backoff := minBackoff
			for {
				err := runChain(ch)
				blockTimeHealth.WithLabelValues(ch.Slug).Set(0)
				blockTimeReconnectCtr.WithLabelValues(ch.Slug).Inc()
				if err != nil {
					fmt.Printf("[%s] WS error: %v (reconnecting in %v)\n", ch.Slug, err, backoff)
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

func runChain(ch L2Chain) error {
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = dialTimeout
	conn, _, err := dialer.Dial(ch.URL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(rpcReq{
		JSONRPC: "2.0", ID: 1, Method: "eth_subscribe",
		Params: []any{"newHeads"},
	}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	blockTimeHealth.WithLabelValues(ch.Slug).Set(1)
	fmt.Printf("[%s] connected, subscribed to newHeads\n", ch.Slug)

	done := make(chan struct{})
	// lastHeadUnixNano is read by the watchdog and written on every new head.
	// Atomic int64 keeps the watchdog lock-free; initial value = connect time
	// so the watchdog gives the subscription a normal head-window grace
	// period before counting silence.
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
				_ = conn.WriteControl(
					websocket.PingMessage,
					nil,
					time.Now().Add(5*time.Second),
				)
			}
		}
	}()
	// Head watchdog. The pong handler extends SetReadDeadline on every pong,
	// so the read deadline alone can't catch a provider that keeps the WS
	// heartbeat alive while silently dropping the subscription. Check every
	// 15s: if we haven't received a head in headWatchdog, slam the connection
	// closed → ReadMessage returns an error → runChain returns → outer loop
	// bumps the reconnect counter and dials again.
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
					fmt.Printf("[%s] watchdog: no head for %s — forcing reconnect\n", ch.Slug, silent.Round(time.Second))
					_ = conn.Close()
					return
				}
			}
		}
	}()
	defer close(done)

	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(readDeadline))
		return nil
	})

	var lastSeen time.Time
	var lastBlockNum int64
	for {
		_ = conn.SetReadDeadline(time.Now().Add(readDeadline))
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var env rpcEnvelope
		if err := json.Unmarshal(msg, &env); err != nil {
			continue
		}
		if env.Method != "eth_subscription" || env.Params == nil {
			// Subscription ack response or unrelated frame — skip.
			continue
		}
		var head newHead
		if err := json.Unmarshal(env.Params.Result, &head); err != nil {
			continue
		}
		blockNum := parseHexInt64(head.Number)
		if blockNum == 0 {
			continue
		}
		// Ignore replays / duplicates from the same connection. Some
		// sequencers re-emit the latest head on subscribe.
		if blockNum <= lastBlockNum {
			continue
		}

		now := time.Now()
		lastHeadUnixNano.Store(now.UnixNano())
		if !lastSeen.IsZero() {
			deltaMs := float64(now.Sub(lastSeen).Milliseconds())
			if deltaMs > 0 && deltaMs < maxSampleMs {
				blockTimeGauge.WithLabelValues(ch.Slug).Set(deltaMs)
				blockTimeHistogram.WithLabelValues(ch.Slug).Observe(deltaMs)
				blockTimeSampleCtr.WithLabelValues(ch.Slug).Inc()
				fmt.Printf("[%s] block=%d block-time=%.0fms\n", ch.Slug, blockNum, deltaMs)
			}
		}
		lastSeen = now
		lastBlockNum = blockNum
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
