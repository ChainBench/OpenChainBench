// layerzero-message-latency: passive LayerZero delivery-latency bench.
//
// Every 60s, polls two pages of https://scan.layerzero-api.com/v1/messages/latest
// for the most recent messages (max 150 per page). For each message the
// monitor has not seen before AND that has DELIVERED status (with both
// source and destination block timestamps present), computes
// `destination.blockTimestamp - source.blockTimestamp` and records it
// in a Prometheus histogram bucketed by source + destination chain.
//
// The harness never sends canary transactions. LayerZero handles enough
// production traffic (~250 msg/hour network-wide) that passive polling
// gives statistically robust p50/p90 per source chain within 24h.
//
// Design notes:
//   - `?status=DELIVERED` querystring filter is broken/undocumented in
//     the API — we filter client-side after unmarshaling.
//   - Fresh INFLIGHT / CONFIRMING messages have empty source.tx blocks.
//     They must be skipped without being added to the dedupe cache so
//     the DELIVERED transition is observed on a later poll.
//   - Timestamps are int64 Unix seconds (source-chain block times), not
//     RFC3339 strings — no ms precision available, no indexer skew (a
//     cleaner signal than Wormhole's `indexedAt`).
//   - Two pages per poll: sustained 250 msg/hour ~= 4/min * 60s = 240
//     new messages per poll. One page (max 150) would miss ~90/min
//     under peak load. Cursor is honored via ?nextToken=.
//   - Dedupe on `guid` via 10k LRU. Sustained rate ~4 msg/s → cache
//     holds ~40 min of history.
package main

import (
	"container/list"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	lzMessagesBase    = "https://scan.layerzero-api.com/v1/messages/latest"
	lzPageLimit       = 150
	lzPagesPerPoll    = 2
	pollInterval      = 60 * time.Second
	requestTimeout    = 15 * time.Second
	dedupeCacheMaxLen = 10_000
	metricsListenAddr = ":2112"
	// Guard against clock skew and stuck messages. Aligned with the
	// other e2e cross-chain messaging benches (CCIP, Hyperlane, Axelar)
	// at 2 hours so the drop threshold is consistent across the
	// cross-chain-messaging-latency meta-bench. Any single message
	// beyond 2h is almost certainly a stuck/re-delivered artifact.
	maxLatencyMs = 7_200_000 // 2 hours
)

type lzTx struct {
	BlockTimestamp int64 `json:"blockTimestamp"`
}

type lzStage struct {
	Tx lzTx `json:"tx"`
}

type lzChainRef struct {
	Chain string `json:"chain"`
}

type lzPathway struct {
	Sender   lzChainRef `json:"sender"`
	Receiver lzChainRef `json:"receiver"`
}

type lzStatus struct {
	Name string `json:"name"`
}

type lzMessage struct {
	GUID        string    `json:"guid"`
	Status      lzStatus  `json:"status"`
	Pathway     lzPathway `json:"pathway"`
	Source      lzStage   `json:"source"`
	Destination lzStage   `json:"destination"`
}

type lzResponse struct {
	Data      []lzMessage `json:"data"`
	NextToken string      `json:"nextToken"`
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

func chainSlug(name string) string {
	if s, ok := lzChainSlug[name]; ok {
		return s
	}
	return "chain-" + strings.ToLower(name)
}

// fetchPage retrieves one page. Returns messages + nextToken (empty if last).
func fetchPage(ctx context.Context, client *http.Client, nextToken string) ([]lzMessage, string, error) {
	v := url.Values{}
	v.Set("limit", fmt.Sprintf("%d", lzPageLimit))
	if nextToken != "" {
		v.Set("nextToken", nextToken)
	}
	target := lzMessagesBase + "?" + v.Encode()
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return nil, "", fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/layerzero-message-latency")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return nil, "", fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var parsed lzResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, "", fmt.Errorf("decode: %w", err)
	}
	return parsed.Data, parsed.NextToken, nil
}

func poll(ctx context.Context, client *http.Client, seen *lruSet) error {
	nextToken := ""
	totalRows := 0
	fresh := 0
	for page := 0; page < lzPagesPerPoll; page++ {
		msgs, nt, err := fetchPage(ctx, client, nextToken)
		if err != nil {
			return err
		}
		totalRows += len(msgs)
		for _, m := range msgs {
			if m.GUID == "" {
				continue
			}
			srcSlug := chainSlug(m.Pathway.Sender.Chain)

			// Record status once (first sighting). Do NOT dedupe on
			// non-DELIVERED yet — we want to observe DELIVERED transition
			// on later poll.
			if !seen.contains(m.GUID) {
				lzStatusTotal.WithLabelValues(srcSlug, m.Status.Name).Inc()
			}

			if m.Status.Name != "DELIVERED" {
				continue
			}
			if m.Source.Tx.BlockTimestamp == 0 || m.Destination.Tx.BlockTimestamp == 0 {
				// Rare — DELIVERED without one of the tx blocks. Mark
				// seen so we don't loop forever on a malformed row.
				seen.add(m.GUID)
				continue
			}
			if seen.contains(m.GUID) {
				continue
			}

			deltaSec := m.Destination.Tx.BlockTimestamp - m.Source.Tx.BlockTimestamp
			deltaMs := float64(deltaSec) * 1000
			if deltaMs < 0 || deltaMs > maxLatencyMs {
				seen.add(m.GUID)
				continue
			}
			dstSlug := chainSlug(m.Pathway.Receiver.Chain)
			lzLatencyMs.WithLabelValues(srcSlug, dstSlug).Observe(deltaMs)
			lzSeenTotal.WithLabelValues(srcSlug, dstSlug).Inc()
			seen.add(m.GUID)
			fresh++
		}
		if nt == "" {
			break
		}
		nextToken = nt
	}
	lzDedupeCacheSize.Set(float64(seen.size()))
	log.Printf("poll: %d rows, %d fresh, dedupe=%d", totalRows, fresh, seen.size())
	return nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("layerzero-message-latency: starting")

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
		lzPollErrors.Inc()
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
				lzPollErrors.Inc()
			}
			mu.Unlock()
		case <-sig:
			log.Println("shutdown")
			return
		}
	}
}
