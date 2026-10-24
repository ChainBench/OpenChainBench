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

// SUI checkpoint cadence. Mysticeti checkpoints are final when committed,
// so the interval between two checkpoints is how often finality lands.
//
// Until 2026-10-24 the sample was the wall-clock gap between two polls
// that saw a new sequence number. Checkpoints come about every 0.2 s and
// the poll every 500 ms, so 2 to 4 were skipped per poll and the series
// read 500 or 1000 ms: our poll interval, not the chain. The sample is now
// (timestamp(N) - timestamp(M)) / (N - M) from the checkpoints' own
// commit timestamps (ms), over whatever the poll advanced.
//
// gRPC streaming (sui.rpc.v2.SubscriptionService.SubscribeCheckpoints)
// is the lower-overhead path but adds a ~10MB protoc-generated stub
// dependency we don't need for this resolution.

// JSON-RPC on the public fullnodes (Mysten, publicnode, BlockVision) was
// retired in October 2026 and answered "Method not found"; the official
// GraphQL service serves the same latest checkpoint.
const suiGraphQLURL = "https://graphql.mainnet.sui.io/graphql"

type suiWSState struct {
	mu      sync.Mutex
	lastSeq int64
	lastTs  time.Time
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
		seqno, ts, err := suiLatestCheckpoint(client)
		if err != nil {
			consecErrors++
			if consecErrors >= 10 {
				return fmt.Errorf("too many errors: %w", err)
			}
			continue
		}
		consecErrors = 0
		st.mu.Lock()
		if ms, ok := st.advance(seqno, ts); ok {
			wallClockLagGauge.WithLabelValues("sui").Set(ms)
			wallClockLagSum.WithLabelValues("sui").Observe(ms)
			wallClockSampleCtr.WithLabelValues("sui").Inc()
			if seqno%100 == 0 {
				fmt.Printf("[L1][sui] checkpoint=%d interval=%.0fms\n", seqno, ms)
			}
		}
		st.mu.Unlock()
	}
	return nil
}

// advance returns the mean checkpoint interval since the previous reading,
// from commit timestamps. The first reading only anchors.
func (st *suiWSState) advance(seq int64, ts time.Time) (float64, bool) {
	if seq <= st.lastSeq {
		return 0, false
	}
	prevSeq, prevTs := st.lastSeq, st.lastTs
	st.lastSeq, st.lastTs = seq, ts
	if prevSeq == 0 || !ts.After(prevTs) {
		return 0, false
	}
	return float64(ts.Sub(prevTs).Milliseconds()) / float64(seq-prevSeq), true
}

func suiLatestCheckpoint(client *http.Client) (int64, time.Time, error) {
	body, _ := json.Marshal(map[string]any{
		"query": "{ checkpoint { sequenceNumber timestamp } }",
	})
	req, _ := http.NewRequest("POST", suiGraphQLURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, time.Time{}, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return parseSuiCheckpoint(respBody)
}

func parseSuiCheckpoint(respBody []byte) (int64, time.Time, error) {
	var r struct {
		Data *struct {
			Checkpoint *struct {
				SequenceNumber json.Number `json:"sequenceNumber"`
				Timestamp      time.Time   `json:"timestamp"`
			} `json:"checkpoint"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(respBody, &r); err != nil {
		return 0, time.Time{}, fmt.Errorf("parse: %w", err)
	}
	if len(r.Errors) > 0 {
		return 0, time.Time{}, fmt.Errorf("graphql: %s", r.Errors[0].Message)
	}
	if r.Data == nil || r.Data.Checkpoint == nil {
		return 0, time.Time{}, fmt.Errorf("graphql: no checkpoint")
	}
	n, err := strconv.ParseInt(r.Data.Checkpoint.SequenceNumber.String(), 10, 64)
	if err != nil {
		return 0, time.Time{}, fmt.Errorf("parse_seq: %w", err)
	}
	return n, r.Data.Checkpoint.Timestamp, nil
}
