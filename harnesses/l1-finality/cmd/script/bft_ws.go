package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
)

// Single-slot BFT chains, timed from the block's own timestamp.
//
// On Sei, Cronos and Kaia a block is final the moment it is committed, and
// the WebSocket head stream only carries committed blocks: first seen and
// final are the same instant, so latest -> finalized is zero by
// construction. What is measurable is the Avalanche-row figure: the block's
// own timestamp to its arrival here, already final.
//
//   - Sei and Cronos (CometBFT): `NewBlockHeader` events over the Tendermint
//     WebSocket carry the header `time` at nanosecond precision. On Sei the
//     header time is the proposer's clock at proposal (it reads 0.2 to 0.3 s
//     before arrival, under one ~0.45 s block interval). On Cronos it is
//     CometBFT BFT time, the median of the validators' precommit times for
//     the previous height, so the figure covers this height's whole round,
//     from the previous commit to this one, plus delivery.
//   - Kaia (Istanbul BFT): the block producer sleeps until the parent's
//     timestamp + 1 s, a whole second, and starts the block then with
//     `timestamp` = parent + 1 (kaia work/worker.go waitForIdealBlockTime,
//     blockchain.go PrepareHeader). For such an on-time block the whole-
//     second timestamp is the start of block building to the millisecond.
//     A late block gets timestamp = now, truncated, with the fraction in
//     `timestampFoS`, which newHeads does not carry: those blocks
//     (timestamp != parent + 1) are not timed.
//
// Readings outside 0 to 60 s are clock skew or a replay, and are dropped.

type bftChain struct {
	slug string
	env  string // WS URL override
	url  string
	kind string // "cometbft" | "kaia"
}

var bftChains = []bftChain{
	{slug: "sei", env: "WS_SEI", url: "wss://sei-rpc.publicnode.com/websocket", kind: "cometbft"},
	{slug: "cronos", env: "WS_CRONOS", url: "wss://cronos-rpc.publicnode.com/websocket", kind: "cometbft"},
	{slug: "kaia", env: "WS_KAIA", url: "wss://public-en.node.kaia.io/ws", kind: "kaia"},
}

func StartBFTWallClock() {
	for _, ch := range bftChains {
		ch := ch
		ch.url = getenvDefault(ch.env, ch.url)
		go func() {
			backoff := 2 * time.Second
			for {
				err := runBFTChain(ch)
				if err != nil {
					fmt.Printf("[L1][%s] WS error: %v (reconnecting in %v)\n", ch.slug, err, backoff)
					wallClockHealth.WithLabelValues(ch.slug).Set(0)
				}
				time.Sleep(backoff)
				if backoff < 60*time.Second {
					backoff *= 2
				}
			}
		}()
	}
}

func runBFTChain(ch bftChain) error {
	conn, _, err := websocket.DefaultDialer.Dial(ch.url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	sub := `{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}`
	if ch.kind == "cometbft" {
		sub = `{"jsonrpc":"2.0","id":1,"method":"subscribe","params":{"query":"tm.event='NewBlockHeader'"}}`
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(sub)); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	wallClockHealth.WithLabelValues(ch.slug).Set(1)
	fmt.Printf("[L1][%s] WS connected, subscribed to heads\n", ch.slug)

	var kaia kaiaState
	n := 0
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		now := time.Now()
		conn.SetReadDeadline(now.Add(30 * time.Second))

		var height int64
		var lag time.Duration
		var ok bool
		if ch.kind == "cometbft" {
			var t time.Time
			height, t, ok = parseCometHeader(msg)
			if ok {
				lag = now.Sub(t)
			}
		} else {
			var num, ts int64
			num, ts, ok = parseEVMHead(msg)
			if ok {
				height = num
				var start time.Time
				start, ok = kaia.onTime(num, ts)
				lag = now.Sub(start)
			}
		}
		if !ok || lag < 0 || lag > 60*time.Second {
			continue
		}
		ms := float64(lag.Milliseconds())
		recordWallClock(ch.slug, ms)
		if n++; n%50 == 0 {
			fmt.Printf("[L1][%s] block=%d lag=%.0fms\n", ch.slug, height, ms)
		}
	}
}

// parseCometHeader reads a CometBFT `NewBlockHeader` event.
func parseCometHeader(msg []byte) (int64, time.Time, bool) {
	var ev struct {
		Result *struct {
			Data *struct {
				Value *struct {
					Header *struct {
						Height json.Number `json:"height"`
						Time   time.Time   `json:"time"`
					} `json:"header"`
				} `json:"value"`
			} `json:"data"`
		} `json:"result"`
	}
	if err := json.Unmarshal(msg, &ev); err != nil {
		return 0, time.Time{}, false
	}
	if ev.Result == nil || ev.Result.Data == nil || ev.Result.Data.Value == nil || ev.Result.Data.Value.Header == nil {
		return 0, time.Time{}, false
	}
	h := ev.Result.Data.Value.Header
	n, err := h.Height.Int64()
	if err != nil || n <= 0 || h.Time.IsZero() {
		return 0, time.Time{}, false
	}
	return n, h.Time, true
}

// parseEVMHead reads an eth_subscription newHeads notification.
func parseEVMHead(msg []byte) (int64, int64, bool) {
	var ev evmSubEvent
	if err := json.Unmarshal(msg, &ev); err != nil || ev.Method != "eth_subscription" || ev.Params == nil {
		return 0, 0, false
	}
	n := parseHexInt(ev.Params.Result.Number)
	ts := parseHexInt(ev.Params.Result.Timestamp)
	if n <= 0 || ts <= 0 {
		return 0, 0, false
	}
	return n, ts, true
}

type kaiaState struct {
	lastNum int64
	lastTs  int64
}

// onTime returns the block's build start when it is an on-time block
// (number = previous + 1 and timestamp = previous + 1 s).
func (st *kaiaState) onTime(num, ts int64) (time.Time, bool) {
	prevNum, prevTs := st.lastNum, st.lastTs
	if num <= prevNum {
		return time.Time{}, false
	}
	st.lastNum, st.lastTs = num, ts
	if num != prevNum+1 || ts != prevTs+1 {
		return time.Time{}, false
	}
	return time.Unix(ts, 0), true
}
