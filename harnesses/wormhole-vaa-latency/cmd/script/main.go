// wormhole-vaa-latency: single-provider observation-only bench.
//
// Every 60s, polls https://api.wormholescan.io/api/v1/vaas?pageSize=100 for
// the most recent VAAs. For each VAA the monitor has not seen before,
// computes `updatedAt − timestamp` as the finalization latency (source-tx
// observation → Guardian quorum reached + indexer wrote the row), and
// records it in a Prometheus histogram bucketed by source chain.
//
// The harness never sends canary transactions — Wormhole handles enough
// organic volume (~thousands of VAAs/day) that passive observation gives
// statistically robust per-chain distributions inside a 24-hour window.
//
// Dedupe: last N=10000 VAA ids kept in memory (rolling LRU on insert
// order). Wormholescan returns ~100 VAAs/min sustained; a 10k cache
// holds ~100 min of history, comfortably wider than the poll window.
package main

import (
	"container/list"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	wormholescanURL   = "https://api.wormholescan.io/api/v1/vaas?pageSize=100"
	pollInterval      = 60 * time.Second
	requestTimeout    = 15 * time.Second
	dedupeCacheMaxLen = 10_000
	metricsListenAddr = ":2112"
)

type vaaEntry struct {
	ID           string `json:"id"`
	EmitterChain int    `json:"emitterChain"`
	Timestamp    string `json:"timestamp"`
	// IndexedAt is the moment wormholescan FIRST indexed the VAA as
	// quorum-signed. Do NOT use `updatedAt`: it gets refreshed by
	// wormholescan's periodic re-indexing (~5-6 min later), which
	// pollutes the latency signal with a bimodal ~350s outlier tail.
	IndexedAt string `json:"indexedAt"`
}

type vaaResponse struct {
	Data []vaaEntry `json:"data"`
}

// lruSet keeps the last N inserted keys, evicting FIFO. Not thread-safe —
// caller (single-goroutine poller) synchronises.
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

func chainSlug(id int) string {
	if s, ok := emitterChainSlug[id]; ok {
		return s
	}
	return "chain" + strconv.Itoa(id)
}

func poll(ctx context.Context, client *http.Client, seen *lruSet) error {
	req, err := http.NewRequestWithContext(ctx, "GET", wormholescanURL, nil)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/wormhole-vaa-latency")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var parsed vaaResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	fresh := 0
	for _, v := range parsed.Data {
		if v.ID == "" || seen.contains(v.ID) {
			continue
		}
		ts, err1 := time.Parse(time.RFC3339, v.Timestamp)
		ix, err2 := time.Parse(time.RFC3339Nano, v.IndexedAt)
		if err1 != nil || err2 != nil {
			// Skip malformed rows silently — wormholescan occasionally
			// backfills with non-RFC3339 nano timestamps; not worth
			// polluting the error counter with parse noise.
			seen.add(v.ID)
			continue
		}
		delta := ix.Sub(ts).Seconds()
		if delta < 0 || delta > 3600 {
			// Guard against clock skew / backfilled VAAs whose
			// indexedAt refers to a much later re-indexing event.
			seen.add(v.ID)
			continue
		}
		slug := chainSlug(v.EmitterChain)
		vaaLatencySeconds.WithLabelValues(slug).Observe(delta)
		vaaSeenTotal.WithLabelValues(slug).Inc()
		seen.add(v.ID)
		fresh++
	}
	dedupeCacheSize.Set(float64(seen.size()))
	log.Printf("poll: %d rows, %d fresh, dedupe cache=%d", len(parsed.Data), fresh, seen.size())
	return nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("wormhole-vaa-latency: starting")

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

	// Prime once immediately so scrapes get non-empty series without
	// waiting the first interval.
	mu.Lock()
	if err := poll(ctx, client, seen); err != nil {
		log.Printf("poll error: %v", err)
		pollErrors.Inc()
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
				pollErrors.Inc()
			}
			mu.Unlock()
		case <-sig:
			log.Println("shutdown")
			return
		}
	}
}
