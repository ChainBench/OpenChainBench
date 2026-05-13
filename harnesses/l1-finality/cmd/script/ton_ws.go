package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// TON wall-clock finality measurement via tonapi.io SSE stream.
//
// The tonapi `/v2/sse/blocks?workchain=-1` endpoint pushes one event per
// masterchain block (~0.4-0.7 s cadence). Per the TON payment-processor
// docs, "a transaction is finalized once included in a masterchain
// block" — so the wall-clock interval between block N and block N+1 is
// the time the network needs to finalize block N. Recording the first
// time we observe each seqno lets us compute that interval with ms
// precision, independent of `gen_utime` second-rounding and our 10 s
// poll cadence.

const tonSSEURL = "https://tonapi.io/v2/sse/blocks?workchain=-1"

type tonState struct {
	mu        sync.Mutex
	firstSeen map[int64]time.Time
	lastSeen  int64
}

type tonSSEMessage struct {
	Workchain int    `json:"workchain"`
	Shard     string `json:"shard"`
	Seqno     int64  `json:"seqno"`
	RootHash  string `json:"root_hash"`
	FileHash  string `json:"file_hash"`
}

// StartTONWallClock launches a persistent SSE subscriber for TON
// masterchain. Reconnects with exponential backoff on error.
func StartTONWallClock() {
	go func() {
		backoff := 2 * time.Second
		for {
			err := runTONSSE()
			if err != nil {
				fmt.Printf("[L1][ton] SSE error: %v (reconnecting in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("ton").Set(0)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

func runTONSSE() error {
	req, err := http.NewRequest("GET", tonSSEURL, nil)
	if err != nil {
		return fmt.Errorf("new_req: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("status_%d", resp.StatusCode)
	}

	wallClockHealth.WithLabelValues("ton").Set(1)
	fmt.Println("[L1][ton] SSE connected, listening for masterchain blocks")

	st := &tonState{firstSeen: map[int64]time.Time{}}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	var dataBuf []string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			// blank line = end of event. Flush and reset.
			if len(dataBuf) > 0 {
				st.handleData(strings.Join(dataBuf, ""))
				dataBuf = nil
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataBuf = append(dataBuf, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("scan: %w", err)
	}
	return fmt.Errorf("stream closed cleanly")
}

func (st *tonState) handleData(payload string) {
	if payload == "" {
		return
	}
	var msg tonSSEMessage
	if err := json.Unmarshal([]byte(payload), &msg); err != nil {
		return
	}
	if msg.Workchain != -1 || msg.Seqno <= 0 {
		return
	}

	now := time.Now()
	st.mu.Lock()
	defer st.mu.Unlock()

	if _, ok := st.firstSeen[msg.Seqno]; !ok {
		st.firstSeen[msg.Seqno] = now
	}

	// Block N is finalized once N+1 is observed. So when we see seqno N
	// for the first time, look up the previous seqno's first-seen time
	// and emit the lag.
	prev := msg.Seqno - 1
	if t, ok := st.firstSeen[prev]; ok && prev > st.lastSeen {
		lagMs := float64(now.Sub(t).Milliseconds())
		if lagMs >= 0 {
			wallClockLagGauge.WithLabelValues("ton").Set(lagMs)
			wallClockLagSum.WithLabelValues("ton").Observe(lagMs)
			wallClockSampleCtr.WithLabelValues("ton").Inc()
			fmt.Printf("[L1][ton] block=%d wall-clock-lag=%.0fms\n", prev, lagMs)
		}
		st.lastSeen = prev
	}

	// GC seen entries older than 1000 blocks.
	if msg.Seqno > 1000 {
		cutoff := msg.Seqno - 1000
		for h := range st.firstSeen {
			if h < cutoff {
				delete(st.firstSeen, h)
			}
		}
	}
}
