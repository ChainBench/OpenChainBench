package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

// Solana wall-clock finality.
//
// The HTTP path (solana.go) subtracted getBlockTime of the processed slot
// from getBlockTime of the finalized one. getBlockTime is whole seconds, so
// it can only resolve finality longer than about a second. Under Tower BFT
// (about 12.8 s) that was fine. Alpenglow went live on mainnet on
// 2026-10-21 around 15:00 UTC (epoch 1064) and finality dropped well under
// a second: the difference became 0 on most samples and 1 on the rest, and
// the published "0.14 s" was the share of samples that straddled a second
// boundary, not a duration. The same trap is why BNB and Avalanche moved to
// evm_ws.go.
//
// This measures it the way evm_ws.go does: T1 is the first time a slot is
// seen at the processed commitment (slotSubscribe), T2 the first time a
// root at or above it arrives (rootSubscribe), lag = T2 - T1 in ms. A
// 60 s probe on 2026-10-22 gave p50 371 ms, and a cross-check that polled
// getSlot(finalized) every 250 ms instead of using roots gave p50 373 ms.

const solanaWSURL = "wss://api.mainnet-beta.solana.com"

type solanaNotification struct {
	Method string `json:"method"`
	Params *struct {
		Result json.RawMessage `json:"result"`
	} `json:"params"`
}

// StartSolanaWallClock runs one reconnecting subscription.
func StartSolanaWallClock() {
	url := getenvDefault("WS_SOLANA", solanaWSURL)
	go func() {
		backoff := 2 * time.Second
		for {
			err := runSolanaWS(url)
			if err != nil {
				fmt.Printf("[L1][solana] WS error: %v (reconnecting in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("solana").Set(0)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

func runSolanaWS(url string) error {
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	st := &wsState{slug: "solana", url: url, firstSeen: map[int64]time.Time{}, conn: conn}
	for i, m := range []string{"slotSubscribe", "rootSubscribe"} {
		if err := st.writeJSON(evmRPCReq{JSONRPC: "2.0", ID: i + 1, Method: m, Params: []any{}}); err != nil {
			return fmt.Errorf("%s: %w", m, err)
		}
	}
	wallClockHealth.WithLabelValues("solana").Set(1)
	fmt.Println("[L1][solana] WS connected, subscribed to slots and roots")

	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		now := time.Now()
		conn.SetReadDeadline(now.Add(30 * time.Second))
		slot, root, ok := parseSolanaNotification(msg)
		if !ok {
			continue
		}
		if slot > 0 {
			st.recordLatest(slot)
		}
		if root > 0 {
			st.recordFinalSolana(root, now)
		}
	}
}

// parseSolanaNotification returns the slot of a slotNotification or the
// root of a rootNotification; ok is false for anything else.
func parseSolanaNotification(msg []byte) (slot, root int64, ok bool) {
	var n solanaNotification
	if json.Unmarshal(msg, &n) != nil || n.Params == nil {
		return 0, 0, false
	}
	switch n.Method {
	case "slotNotification":
		var r struct {
			Slot int64 `json:"slot"`
		}
		if json.Unmarshal(n.Params.Result, &r) != nil {
			return 0, 0, false
		}
		return r.Slot, 0, true
	case "rootNotification":
		var r int64
		if json.Unmarshal(n.Params.Result, &r) != nil {
			return 0, 0, false
		}
		return 0, r, true
	}
	return 0, 0, false
}

// recordFinalSolana is recordFinal without the per-slot log line: Solana
// roots about 2.5 slots a second, and the EVM path's one line per block
// would be the bulk of the container log.
func (st *wsState) recordFinalSolana(root int64, now time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if root <= st.lastFinal {
		return
	}
	n := 0
	var last float64
	for s, t := range st.firstSeen {
		if s > st.lastFinal && s <= root {
			lagMs := float64(now.Sub(t).Milliseconds())
			if lagMs >= 0 {
				wallClockLagGauge.WithLabelValues("solana").Set(lagMs)
				wallClockLagSum.WithLabelValues("solana").Observe(lagMs)
				wallClockSampleCtr.WithLabelValues("solana").Inc()
				n++
				last = lagMs
			}
			delete(st.firstSeen, s)
		}
	}
	st.lastFinal = root
	for s := range st.firstSeen {
		if s < root-1000 {
			delete(st.firstSeen, s)
		}
	}
	if n > 0 && root%50 == 0 {
		fmt.Fprintf(os.Stdout, "[L1][solana] root=%d samples=%d last-lag=%.0fms\n", root, n, last)
	}
}
