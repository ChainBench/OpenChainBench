package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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
// masterchain. Reconnects with exponential backoff on error. When the
// SSE stream is unavailable (tonapi gated it behind auth in 2026-06 and
// deprecated it in favor of webhooks), falls back to fast-polling the
// anonymous REST head endpoint so the wallclock metrics keep flowing at
// ~±300 ms precision instead of flatlining at health=0.
func StartTONWallClock() {
	go func() {
		backoff := 2 * time.Second
		for {
			err := runTONSSE()
			if err != nil {
				fmt.Printf("[L1][ton] SSE error: %v (reconnecting in %v)\n", err, backoff)
				wallClockHealth.WithLabelValues("ton").Set(0)
				// Run the REST fallback for a window, then retry SSE
				// (the key may have been provisioned + service restarted,
				// or tonapi may have restored the stream).
				pollTONWallClock(5 * time.Minute)
			}
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

// pollTONWallClock approximates the SSE wall-clock measurement by
// polling masterchain-head every 300 ms (anonymous REST tier allows it;
// 429s back the cadence off). Emits the same metric family as the SSE
// path: first sight of seqno N finalizes N-1.
func pollTONWallClock(window time.Duration) {
	fmt.Println("[L1][ton] falling back to REST fast-poll wallclock")
	client := &http.Client{Timeout: 5 * time.Second}
	st := &tonState{firstSeen: map[int64]time.Time{}}
	interval := 300 * time.Millisecond
	deadline := time.Now().Add(window)
	healthy := false
	for time.Now().Before(deadline) {
		head, err := tonapiHead(client, tonAPIBase)
		if err != nil {
			if strings.Contains(err.Error(), "status_429") && interval < 2*time.Second {
				interval *= 2
				fmt.Printf("[L1][ton] poll throttled, backing off to %v\n", interval)
			}
			time.Sleep(interval)
			continue
		}
		if !healthy {
			wallClockHealth.WithLabelValues("ton").Set(1)
			healthy = true
		}
		// Cap at 2 s in poll mode: TON masterchain cadence is 0.4-0.7 s,
		// so a multi-second "lag" here is poll aliasing (429 backoff
		// stretching the cadence), not finality. Observed pre-cap: 10.6 s
		// garbage samples polluting the 24h histogram.
		st.observeSeqno(head.Seqno, 2000)
		time.Sleep(interval)
	}
	wallClockHealth.WithLabelValues("ton").Set(0)
}

// observeSeqno records the first-seen time of a masterchain seqno and
// emits the finality lag for the previous block, mirroring handleData.
// maxLagMs > 0 discards implausible lags (poll-mode aliasing guard);
// 0 means no cap (SSE events carry true arrival times).
func (st *tonState) observeSeqno(seqno int64, maxLagMs float64) {
	if seqno <= 0 {
		return
	}
	now := time.Now()
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, ok := st.firstSeen[seqno]; !ok {
		st.firstSeen[seqno] = now
	}
	prev := seqno - 1
	if t, ok := st.firstSeen[prev]; ok && prev > st.lastSeen {
		lagMs := float64(now.Sub(t).Milliseconds())
		if lagMs >= 0 && (maxLagMs == 0 || lagMs <= maxLagMs) {
			wallClockLagGauge.WithLabelValues("ton").Set(lagMs)
			wallClockLagSum.WithLabelValues("ton").Observe(lagMs)
			wallClockSampleCtr.WithLabelValues("ton").Inc()
			mode := ""
			if maxLagMs > 0 {
				mode = " (poll)"
			}
			fmt.Printf("[L1][ton] block=%d wall-clock-lag=%.0fms%s\n", prev, lagMs, mode)
		}
		st.lastSeen = prev
	}
	if seqno > 1000 {
		cutoff := seqno - 1000
		for h := range st.firstSeen {
			if h < cutoff {
				delete(st.firstSeen, h)
			}
		}
	}
}

func runTONSSE() error {
	req, err := http.NewRequest("GET", tonSSEURL, nil)
	if err != nil {
		return fmt.Errorf("new_req: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	// tonapi.io gated the SSE stream behind auth (observed 2026-06-11:
	// anonymous requests get 401; REST endpoints stay open). Reuse the
	// same key the REST poller sends.
	if k := os.Getenv("TON_API_KEY"); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}

	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 && os.Getenv("TON_API_KEY") == "" {
		return fmt.Errorf("status_401 (tonapi SSE now requires a key: set TON_API_KEY on this service, free tier at tonconsole.com)")
	}
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
	// Block N is finalized once N+1 is observed: shared emission logic
	// with the REST fallback poller.
	st.observeSeqno(msg.Seqno, 0)
}
