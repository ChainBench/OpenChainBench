// chainlink-ccip-latency: passive Chainlink CCIP message latency bench.
//
// Every 60s, polls https://api.ccip.chain.link/v2/messages?limit=100 for
// the most recent CCIP messages. For each message the monitor has not
// seen before AND that has completed (`status == SUCCESS`), computes
// `receiptTimestamp - sendTimestamp` and records it in a Prometheus
// histogram bucketed by source + destination chain.
//
// The harness never sends canary transactions — CCIP handles enough
// production traffic (several hundred messages per day across the top
// corridors) that passive polling gives statistically robust p50/p90
// per corridor inside a 24-hour window.
//
// Design notes:
//   - We filter out `environment != "mainnet"` before observing.
//     Testnet lanes have wildly different profiles and would poison the
//     leaderboard.
//   - Statuses other than SUCCESS (SENT, SOURCE_FINALIZED, COMMITTED,
//     FAILED, ...) are counted separately as `ccip_message_status_total`
//     so a spike in COMMITTED without matching SUCCESS surfaces a
//     stuck-execution incident without polluting latency data.
//   - CCIP intentionally waits for source-chain finality before its DON
//     commits. Ethereum-source lanes therefore include ~13min of
//     finality wait. We expose this in the raw histogram; the fair
//     comparison to Wormhole (finality-agnostic) lives in the meta-bench.
//   - Dedupe on `messageId` via a 10k-entry LRU. Sustained rate is
//     ~25 msg/min across the network, so the cache holds ~7h of history.
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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	ccipMessagesURL   = "https://api.ccip.chain.link/v2/messages?limit=100"
	pollInterval      = 60 * time.Second
	requestTimeout    = 15 * time.Second
	dedupeCacheMaxLen = 10_000
	metricsListenAddr = ":2112"
	// Guard against clock skew or backfilled rows: any latency > 2h is
	// almost certainly noise (a stuck message re-executed later, or a
	// timestamp typo). Kept generous because CCIP finality wait on ETH
	// legitimately reaches ~25 min in bad epochs.
	maxLatencyMs = 7_200_000 // 2h
)

type ccipNetwork struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Environment string `json:"environment"`
}

type ccipMessage struct {
	MessageID         string      `json:"messageId"`
	Status            string      `json:"status"`
	SourceNetworkInfo ccipNetwork `json:"sourceNetworkInfo"`
	DestNetworkInfo   ccipNetwork `json:"destNetworkInfo"`
	SendTimestamp     string      `json:"sendTimestamp"`
	ReceiptTimestamp  *string     `json:"receiptTimestamp"`
}

type ccipResponse struct {
	Data []ccipMessage `json:"data"`
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

// chainSlugFromCCIPName maps CCIP's kebab-case network name to the OCB
// canonical chain slug. Unknown names get a `chain-<lowered>` fallback
// so we never drop data silently — the label just shows up as a new row
// and we add the mapping to chains.go next release.
func chainSlugFromCCIPName(name string) string {
	if s, ok := ccipChainSlug[name]; ok {
		return s
	}
	// Strip "-mainnet" suffix, lowercase, dashes preserved.
	name = strings.TrimSuffix(name, "-mainnet")
	name = strings.ToLower(name)
	return "chain-" + name
}

func poll(ctx context.Context, client *http.Client, seen *lruSet) error {
	req, err := http.NewRequestWithContext(ctx, "GET", ccipMessagesURL, nil)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/chainlink-ccip-latency")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var parsed ccipResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	fresh := 0
	success := 0
	for _, m := range parsed.Data {
		if m.MessageID == "" {
			continue
		}
		// Testnet lanes are noise for a production latency bench —
		// drop before doing anything else so they don't touch the
		// status counter either.
		if m.SourceNetworkInfo.Environment != "mainnet" ||
			m.DestNetworkInfo.Environment != "mainnet" {
			continue
		}

		srcSlug := chainSlugFromCCIPName(m.SourceNetworkInfo.Name)
		dstSlug := chainSlugFromCCIPName(m.DestNetworkInfo.Name)

		// Count every status we see (once per messageId), even before
		// the message reaches SUCCESS, so the stuck-pipeline signal
		// surfaces in Prom without waiting for completion.
		if !seen.contains(m.MessageID) {
			ccipStatusTotal.WithLabelValues(srcSlug, m.Status).Inc()
		}

		if m.Status != "SUCCESS" || m.ReceiptTimestamp == nil {
			// Do NOT add to dedupe yet — we want to observe the
			// SUCCESS transition when it eventually appears.
			continue
		}
		if seen.contains(m.MessageID) {
			continue
		}

		sendTs, err1 := time.Parse(time.RFC3339, m.SendTimestamp)
		recvTs, err2 := time.Parse(time.RFC3339, *m.ReceiptTimestamp)
		if err1 != nil || err2 != nil {
			// Malformed timestamps — mark seen so we don't retry
			// forever, but skip the histogram observation.
			seen.add(m.MessageID)
			continue
		}
		deltaMs := float64(recvTs.Sub(sendTs).Milliseconds())
		if deltaMs < 0 || deltaMs > maxLatencyMs {
			seen.add(m.MessageID)
			continue
		}
		ccipLatencyMs.WithLabelValues(srcSlug, dstSlug).Observe(deltaMs)
		ccipSeenTotal.WithLabelValues(srcSlug, dstSlug).Inc()
		seen.add(m.MessageID)
		fresh++
		success++
	}
	ccipDedupeCacheSize.Set(float64(seen.size()))
	log.Printf("poll: %d rows, %d success-fresh, dedupe=%d", len(parsed.Data), success, seen.size())
	return nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("chainlink-ccip-latency: starting")

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
		ccipPollErrors.Inc()
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
				ccipPollErrors.Inc()
			}
			mu.Unlock()
		case <-sig:
			log.Println("shutdown")
			return
		}
	}
}
