package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// SUI wall-clock measurement via high-frequency HTTP polling of the
// public fullnode. SUI's checkpoint cadence is ~250-500ms, so we poll
// `sui_getLatestCheckpointSequenceNumber` every 500ms and time the
// arrival of each new checkpoint sequence. lag(N) = T_recv(N+1) -
// T_recv(N) — the actual wall-clock interval the next checkpoint takes
// to land on this client. Mysticeti finalizes at checkpoint commit so
// each arrived sequence is already final; the metric captures protocol
// heartbeat + network propagation, the closest fair "real finality"
// number we can get without running a validator.
//
// gRPC streaming (sui.rpc.v2.SubscriptionService.SubscribeCheckpoints)
// is the lower-overhead path but adds a ~10MB protoc-generated stub
// dependency we don't need for this resolution.

const suiRPCURL = "https://fullnode.mainnet.sui.io:443"

type suiWSState struct {
	mu       sync.Mutex
	lastSeq  int64
	lastSeen time.Time
}

// StartSUIWallClock launches a goroutine that polls the SUI fullnode at
// 500ms cadence and emits l1_finality_wallclock_lag_milliseconds when
// it observes a new checkpoint.
func StartSUIWallClock() {
	go func() {
		backoff := 2 * time.Second
		for {
			err := runSUIPoll()
			if err != nil {
				fmt.Printf("[L1][sui] poll error: %v (retrying in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("sui").Set(0)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

func runSUIPoll() error {
	wallClockHealth.WithLabelValues("sui").Set(1)
	st := &suiWSState{}
	client := &http.Client{Timeout: 4 * time.Second}
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	consecErrors := 0
	for range tick.C {
		seqno, err := suiLatestCheckpoint(client)
		if err != nil {
			consecErrors++
			if consecErrors >= 10 {
				return fmt.Errorf("too many errors: %w", err)
			}
			continue
		}
		consecErrors = 0
		now := time.Now()
		st.mu.Lock()
		if seqno > st.lastSeq {
			if !st.lastSeen.IsZero() && st.lastSeq > 0 {
				lagMs := float64(now.Sub(st.lastSeen).Milliseconds())
				if lagMs >= 0 {
					wallClockLagGauge.WithLabelValues("sui").Set(lagMs)
					wallClockLagSum.WithLabelValues("sui").Observe(lagMs)
					wallClockSampleCtr.WithLabelValues("sui").Inc()
					fmt.Printf("[L1][sui] checkpoint=%d wall-clock-lag=%.0fms\n", seqno, lagMs)
				}
			}
			st.lastSeen = now
			st.lastSeq = seqno
		}
		st.mu.Unlock()
	}
	return nil
}

func suiLatestCheckpoint(client *http.Client) (int64, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"method": "sui_getLatestCheckpointSequenceNumber",
		"params": []any{},
	})
	req, _ := http.NewRequest("POST", suiRPCURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	var r struct {
		Result string `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(respBody, &r); err != nil {
		return 0, fmt.Errorf("parse: %w", err)
	}
	if r.Error != nil {
		return 0, fmt.Errorf("rpc: %s", r.Error.Message)
	}
	n, err := strconv.ParseInt(r.Result, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse_seq: %w", err)
	}
	return n, nil
}
