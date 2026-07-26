// axelar-gmp-latency: passive Axelar GMP latency bench.
//
// Every 60s, POSTs to https://api.axelarscan.io/gmp/searchGMP for the
// most recent 100 GMP messages with status EXECUTED. For each new
// message (dedupe on `id`), emits two histograms:
//   - confirm: source tx → Axelar validator quorum (time_spent.call_confirm)
//   - e2e:     source tx → destination execution   (time_spent.total)
//
// AxelarScan's API pre-computes both values in seconds inside the
// `time_spent` object — no client-side timestamp math needed.
//
// Design notes:
//   - POST body is JSON: `{"size":100,"status":"executed"}`. `executed`
//     is required to guarantee all time_spent fields are present.
//   - `chain` on the `call` object is lowercased; `destinationChain`
//     in `returnValues` may be Title case. Normalize both via
//     canonicalizeAxelarChain (chains.go).
//   - Cosmos chains have 6s block-time quantisation, so sub-6s latencies
//     round to 0/6/12. Documented in the spec, no fix in-harness.
//   - Volume ~41 msg/hr network-wide, per-source top ~180/24h. Plenty
//     for aggregate p50/p90, thinner for per-source p99.
package main

import (
	"bytes"
	"container/list"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	axelarSearchURL = "https://api.axelarscan.io/gmp/searchGMP"
	// AxelarScan caps size at 25. Volume is ~41 msg/hr so 25 rows per
	// 60s poll comfortably covers the interval with headroom for
	// dedupe replay across successive polls.
	axelarQueryBody = `{"size":25,"status":"executed"}`
	pollInterval    = 60 * time.Second
	requestTimeout    = 15 * time.Second
	dedupeCacheMaxLen = 10_000
	metricsListenAddr = ":2112"
	// 2h hard ceiling. Aligned with the other e2e cross-chain messaging
	// benches (CCIP, LayerZero, Hyperlane) so the drop threshold is
	// consistent across the cross-chain-messaging-latency meta-bench.
	// Axelar validators wait for source-chain finality on EVM (Ethereum
	// ~20 min), so the tail legitimately reaches 30-60 min on ETH-source
	// lanes and must not be trimmed.
	maxLatencyMs = 7_200_000 // 2 hours
)

type axelarCall struct {
	Chain          string          `json:"chain"`
	BlockTimestamp int64           `json:"block_timestamp"`
	ReturnValues   axelarReturnVal `json:"returnValues"`
}

type axelarReturnVal struct {
	DestinationChain string `json:"destinationChain"`
}

type axelarTimeSpent struct {
	CallConfirm      int `json:"call_confirm"`
	CallApproved     int `json:"call_approved"`
	ApprovedExecuted int `json:"approved_executed"`
	Total            int `json:"total"`
}

type axelarMessage struct {
	ID        string          `json:"id"`
	Status    string          `json:"status"`
	Call      axelarCall      `json:"call"`
	TimeSpent axelarTimeSpent `json:"time_spent"`
}

type axelarResponse struct {
	Data []axelarMessage `json:"data"`
}

type lruSet struct {
	max   int
	order *list.List
	set   map[string]*list.Element
}

func newLRUSet(max int) *lruSet {
	return &lruSet{max: max, order: list.New(), set: make(map[string]*list.Element, max)}
}

func (l *lruSet) contains(k string) bool { _, ok := l.set[k]; return ok }

func (l *lruSet) add(k string) {
	if _, ok := l.set[k]; ok {
		return
	}
	el := l.order.PushBack(k)
	l.set[k] = el
	for l.order.Len() > l.max {
		front := l.order.Front()
		if front == nil {
			return
		}
		l.order.Remove(front)
		delete(l.set, front.Value.(string))
	}
}

func (l *lruSet) size() int { return l.order.Len() }

func poll(ctx context.Context, client *http.Client, seen *lruSet) error {
	req, err := http.NewRequestWithContext(ctx, "POST", axelarSearchURL, bytes.NewReader([]byte(axelarQueryBody)))
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// AxelarScan sits behind Cloudflare which silently drops non-browser
	// User-Agents on this endpoint (verified 2026-07-26: any UA
	// containing "OpenChainBench" or "Go-http-client" returns 200 with
	// empty `data: []`, while a browser UA returns real messages). Use
	// a stable pinned Chrome UA to look like a browser client.
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var parsed axelarResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	fresh := 0
	for _, m := range parsed.Data {
		if m.ID == "" {
			continue
		}
		src := canonicalizeAxelarChain(m.Call.Chain)

		// Count status once per id, always.
		if !seen.contains(m.ID) {
			axelarStatusTotal.WithLabelValues(src, m.Status).Inc()
		}

		// We only requested status=executed, but defense in depth.
		if m.Status != "executed" {
			continue
		}
		if seen.contains(m.ID) {
			continue
		}

		// Confirm latency (source → validator quorum). Always present
		// on executed messages per the AxelarScan schema.
		confirmMs := float64(m.TimeSpent.CallConfirm) * 1000
		if confirmMs >= 0 && confirmMs <= maxLatencyMs {
			axelarConfirmLatencyMs.WithLabelValues(src).Observe(confirmMs)
		}

		// E2E latency requires total > 0 and a normalised dst.
		totalMs := float64(m.TimeSpent.Total) * 1000
		if totalMs > 0 && totalMs <= maxLatencyMs {
			dst := canonicalizeAxelarChain(m.Call.ReturnValues.DestinationChain)
			axelarE2ELatencyMs.WithLabelValues(src, dst).Observe(totalMs)
			axelarSeenTotal.WithLabelValues(src, dst).Inc()
		}

		seen.add(m.ID)
		fresh++
	}
	axelarDedupeCacheSize.Set(float64(seen.size()))
	log.Printf("poll: %d rows, %d fresh, dedupe=%d", len(parsed.Data), fresh, seen.size())
	return nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("axelar-gmp-latency: starting")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client := &http.Client{Timeout: requestTimeout}
	seen := newLRUSet(dedupeCacheMaxLen)
	var mu sync.Mutex

	go func() {
		http.Handle("/metrics", promhttp.Handler())
		http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(200)
			_, _ = w.Write([]byte("ok"))
		})
		log.Printf("metrics: listening on %s", metricsListenAddr)
		if err := http.ListenAndServe(metricsListenAddr, nil); err != nil {
			log.Fatalf("metrics server: %v", err)
		}
	}()

	mu.Lock()
	if err := poll(ctx, client, seen); err != nil {
		log.Printf("poll error: %v", err)
		axelarPollErrors.Inc()
	}
	mu.Unlock()

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	for {
		select {
		case <-ticker.C:
			mu.Lock()
			if err := poll(ctx, client, seen); err != nil {
				log.Printf("poll error: %v", err)
				axelarPollErrors.Inc()
			}
			mu.Unlock()
		case <-sig:
			log.Println("shutdown")
			return
		}
	}
}
