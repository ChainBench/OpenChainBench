package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Stellar ledger close interval, from the ledgers' own close times.
//
// SCP finalizes at every ledger close, so the interval between two closes is
// how often finality lands (the SUI checkpoint row's method). The public
// Horizon `/ledgers?cursor=now` SSE stream emits one event per closed ledger
// with its `closed_at`.
//
// Until 2026-11-03 the sample was the gap between two ledgers ARRIVING on the
// stream, on our clock. Horizon delivers them unevenly: on 3 November 2026
// arrival gaps read 3.1, 4.0 and 7.1 s on ledgers whose closed_at were all
// exactly 5 s apart (199 of the last 200), so the published p50 of 4.0 s was
// a delivery artifact, not the chain, and p90 reached 11 s. closed_at is whole
// seconds, so the sample is now the mean over the last ten closes:
// (closed_at(N) - closed_at(N-10)) / 10, with 0.1 s resolution, emitted once
// per new ledger. Replayed ledgers count: their close time is the chain's,
// whenever they reach us.
//
// Quirks:
//   - Public Horizon force-closes the SSE every ~10s with `event: close`,
//     expecting clients to reconnect using the last `id:` as cursor.
//   - The connection respects `cursor=<last_id>` to replay missed
//     ledgers, so reconnects don't drop data.
//   - Each event counts toward Horizon's 3600 req/hr/IP rate limit.
//     With ledgers every ~5s + reconnects every ~10s we use ~1100/hr,
//     well under the cap.

const (
	stellarHorizonSSEURL = "https://horizon.stellar.org/ledgers?order=asc&cursor=%s"
	stellarWindow        = 10
)

type stellarLedgerEvent struct {
	Sequence int64  `json:"sequence"`
	ClosedAt string `json:"closed_at"`
	ID       string `json:"paging_token"`
}

type stellarCloses struct {
	closes   map[int64]time.Time
	lastEmit int64
}

func newStellarCloses() *stellarCloses {
	return &stellarCloses{closes: map[int64]time.Time{}}
}

// add records a ledger close and returns the mean close interval (ms) over
// the last stellarWindow ledgers, once per new ledger.
func (st *stellarCloses) add(seq int64, closedAt time.Time) (float64, bool) {
	if seq <= 0 || closedAt.IsZero() {
		return 0, false
	}
	st.closes[seq] = closedAt
	for s := range st.closes {
		if s < seq-5*stellarWindow {
			delete(st.closes, s)
		}
	}
	if seq <= st.lastEmit {
		return 0, false
	}
	from, ok := st.closes[seq-stellarWindow]
	if !ok {
		return 0, false
	}
	ms := float64(closedAt.Sub(from).Milliseconds()) / stellarWindow
	if ms <= 0 || ms >= 30_000 {
		return 0, false
	}
	st.lastEmit = seq
	return ms, true
}

func StartStellarWallClock() {
	go func() {
		const baseBackoff = 1 * time.Second
		backoff := baseBackoff
		cursor := "now"
		st := newStellarCloses()
		for {
			nextCursor, err := runStellarSSE(cursor, st)
			if nextCursor != "" {
				cursor = nextCursor
			}
			if err == nil {
				// Graceful close. Horizon force-closes every SSE
				// connection after ~10s with `event: close` and expects
				// the client to reconnect using cursor=<last_id>. That is
				// the protocol working as designed, not a failure.
				// Reconnect quickly and keep the backoff at its floor
				// (an earlier loop doubled it on every close and left the
				// row nearly empty).
				backoff = baseBackoff
				time.Sleep(baseBackoff)
				continue
			}
			fmt.Printf("[L1][stellar] SSE error: %v (reconnecting in %v)\n", err, backoff)
			wallClockHealth.WithLabelValues("stellar").Set(0)
			time.Sleep(backoff)
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}()
}

// runStellarSSE opens one SSE connection. Returns the last seen cursor
// so the caller can resume from there on reconnect.
func runStellarSSE(cursor string, st *stellarCloses) (string, error) {
	url := fmt.Sprintf(stellarHorizonSSEURL, cursor)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return cursor, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		return cursor, fmt.Errorf("dial: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return cursor, fmt.Errorf("status_%d", resp.StatusCode)
	}

	wallClockHealth.WithLabelValues("stellar").Set(1)
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	var dataBuf []string
	var lastID string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if len(dataBuf) > 0 {
				payload := strings.Join(dataBuf, "")
				dataBuf = nil
				// Skip non-ledger events (e.g. "hello", "byebye").
				if !strings.HasPrefix(payload, "{") {
					continue
				}
				var ev stellarLedgerEvent
				if err := json.Unmarshal([]byte(payload), &ev); err != nil {
					continue
				}
				if ev.Sequence == 0 {
					continue
				}
				lastID = ev.ID
				closedAt, perr := time.Parse(time.RFC3339, ev.ClosedAt)
				if perr != nil {
					continue
				}
				if ms, ok := st.add(ev.Sequence, closedAt); ok {
					wallClockLagGauge.WithLabelValues("stellar").Set(ms)
					wallClockLagSum.WithLabelValues("stellar").Observe(ms)
					wallClockSampleCtr.WithLabelValues("stellar").Inc()
					if ev.Sequence%20 == 0 {
						fmt.Printf("[L1][stellar] ledger=%d close-interval=%.0fms\n", ev.Sequence, ms)
					}
				}
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataBuf = append(dataBuf, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return lastID, fmt.Errorf("scan: %w", err)
	}
	// Clean EOF: Horizon's routine ~10s force-close. Not an error; the
	// caller reconnects immediately with the returned cursor.
	return lastID, nil
}
