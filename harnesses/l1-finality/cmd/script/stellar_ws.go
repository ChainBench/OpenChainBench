package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Stellar wall-clock measurement via Horizon SSE.
//
// The public Horizon `/ledgers?cursor=now` SSE stream emits one event
// per externalized ledger (~5-7s SCP cadence). We record T_recv when
// each ledger arrives and report lag = T_recv(N+1) - T_recv(N) — the
// actual wall-clock close interval as observed by a public client.
//
// Quirks:
//   - Public Horizon force-closes the SSE every ~10s with `event: close`,
//     expecting clients to reconnect using the last `id:` as cursor.
//   - The connection respects `cursor=<last_id>` to replay missed
//     ledgers, so reconnects don't drop data.
//   - Each event counts toward Horizon's 3600 req/hr/IP rate limit.
//     With ledgers every ~5s + reconnects every ~10s we use ~1100/hr,
//     well under the cap.

const stellarHorizonSSEURL = "https://horizon.stellar.org/ledgers?order=asc&cursor=%s"

type stellarLedgerEvent struct {
	Sequence int64  `json:"sequence"`
	ClosedAt string `json:"closed_at"`
	ID       string `json:"paging_token"`
}

func StartStellarWallClock() {
	go func() {
		const baseBackoff = 1 * time.Second
		backoff := baseBackoff
		cursor := "now"
		var lastSeen time.Time
		var lastSeq int64
		for {
			nextCursor, err := runStellarSSE(cursor, &lastSeen, &lastSeq)
			if nextCursor != "" {
				cursor = nextCursor
			}
			if err == nil {
				// Graceful close. Horizon force-closes every SSE
				// connection after ~10s with `event: close` and expects
				// the client to reconnect using cursor=<last_id>. That is
				// the protocol working as designed, not a failure.
				// Reconnect quickly and keep the backoff at its floor.
				//
				// BUG HISTORY (why the Stellar row went dead): the
				// previous loop treated every stream end as an error and
				// doubled the backoff without ever resetting it, so
				// within a minute of startup it slept 64s between ~10s
				// connection windows. During each window the replayed
				// ledgers failed the 6s liveness filter and the first
				// live event exceeded the 30s sanity bound, so the gauge
				// almost never received a sample and last_over_time on
				// the page eventually returned nothing.
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
func runStellarSSE(cursor string, lastSeen *time.Time, lastSeq *int64) (string, error) {
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

				// Skip replays. Horizon force-closes the SSE every ~10s
				// and on reconnect (cursor=last_id) replays the ledgers
				// we missed back-to-back, microseconds apart. Recording
				// those polluted p50/p90 down to 0ms even though the
				// real SCP cadence is 5-7s. Compare event `closed_at`
				// against now: if it's older than ~6s the event is
				// historical and we drop it.
				//
				// We DO NOT reset lastSeen here. The previous version
				// did `*lastSeen = time.Time{}`, which combined with the
				// `!lastSeen.IsZero()` guard below caused the first
				// live event after every reconnect to be silently
				// skipped. Since Horizon force-closes every ~10s and the
				// SCP cadence is ~5-7s, we'd typically see only 1-2 live
				// events between reconnects — losing the first one left
				// the gauge mostly empty (Prom dashboard showed Stellar
				// as silent). With the reset removed, the first live
				// event after each reconnect contributes a sample using
				// the lastSeen baseline that survived from the previous
				// connection cycle. The 30 s sanity bound below filters
				// the natural reconnect outlier so it doesn't skew p50.
				closedAt, perr := time.Parse(time.RFC3339, ev.ClosedAt)
				isLive := perr == nil && time.Since(closedAt) < 6*time.Second
				if !isLive {
					*lastSeq = ev.Sequence
					continue
				}

				now := time.Now()
				if !lastSeen.IsZero() && *lastSeq > 0 && ev.Sequence > *lastSeq {
					lagMs := float64(now.Sub(*lastSeen).Milliseconds())
					// Real SCP cadence is 5-7 s; anything > 30 s is a
					// reconnect artifact (we crossed a 10 s SSE close +
					// a few seconds of replay catch-up) and should not
					// pollute the distribution.
					if lagMs >= 0 && lagMs < 30_000 {
						wallClockLagGauge.WithLabelValues("stellar").Set(lagMs)
						wallClockLagSum.WithLabelValues("stellar").Observe(lagMs)
						wallClockSampleCtr.WithLabelValues("stellar").Inc()
						fmt.Printf("[L1][stellar] ledger=%d wall-clock-lag=%.0fms\n", ev.Sequence, lagMs)
					}
				}
				*lastSeen = now
				*lastSeq = ev.Sequence
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
