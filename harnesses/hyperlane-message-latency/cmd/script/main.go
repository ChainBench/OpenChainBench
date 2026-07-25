// hyperlane-message-latency: passive Hyperlane delivery-latency bench.
//
// Every 60s, POSTs a GraphQL query to https://api.hyperlane.xyz/v1/graphql
// (Hasura) for the most recent 100 messages ordered by id DESC. For
// each message the monitor has not seen before AND that has
// is_delivered=true, computes `delivery_occurred_at - send_occurred_at`
// and records it in a Prometheus histogram bucketed by source +
// destination chain.
//
// Undelivered messages are counted separately (permissionless relayers
// mean some routes go under-served; a spike surfaces stuck relayer
// coverage rather than protocol latency).
//
// Design notes:
//   - MUST use `order_by: {id: desc}`. Ordering by `send_occurred_at`
//     hits Hasura's 5s query timeout (agent-verified).
//   - `delivery_latency` is a Postgres interval string; we ignore it and
//     compute the delta from the two timestamps directly (equivalent,
//     avoids interval parsing).
//   - Timestamps are ISO 8601 without timezone (`2026-07-25T23:36:42`).
//     Parse as UTC.
//   - Sustained volume ~150/hr → poll 100 rows/60s always covers the
//     interval with margin; no pagination required.
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
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	hyperlaneGraphQLURL = "https://api.hyperlane.xyz/v1/graphql"
	hyperlaneQuery      = `{"query":"{ message_view(limit: 100, order_by: {id: desc}) { msg_id origin_chain_id destination_chain_id is_delivered send_occurred_at delivery_occurred_at } }"}`
	pollInterval        = 60 * time.Second
	requestTimeout      = 15 * time.Second
	dedupeCacheMaxLen   = 10_000
	metricsListenAddr   = ":2112"
	// 30 min hard ceiling — Hyperlane relayers are typically < 2 min
	// end-to-end; > 30 min is either a stuck message or clock skew.
	maxLatencyMs = 1_800_000
)

type hyperlaneMessage struct {
	MsgID              string  `json:"msg_id"`
	OriginChainID      int     `json:"origin_chain_id"`
	DestinationChainID int     `json:"destination_chain_id"`
	IsDelivered        bool    `json:"is_delivered"`
	SendOccurredAt     string  `json:"send_occurred_at"`
	DeliveryOccurredAt *string `json:"delivery_occurred_at"`
}

type hyperlaneResponse struct {
	Data struct {
		MessageView []hyperlaneMessage `json:"message_view"`
	} `json:"data"`
	Errors []map[string]interface{} `json:"errors,omitempty"`
}

// Timestamps come back without timezone info; force UTC on parse.
var hyperlaneTimeLayout = "2006-01-02T15:04:05"

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
	if s, ok := hyperlaneChainSlug[id]; ok {
		return s
	}
	return "chain-" + strconv.Itoa(id)
}

func poll(ctx context.Context, client *http.Client, seen *lruSet) error {
	req, err := http.NewRequestWithContext(ctx, "POST", hyperlaneGraphQLURL, bytes.NewReader([]byte(hyperlaneQuery)))
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OpenChainBench/hyperlane-message-latency")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var parsed hyperlaneResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if len(parsed.Errors) > 0 {
		return fmt.Errorf("graphql errors: %v", parsed.Errors)
	}
	fresh := 0
	for _, m := range parsed.Data.MessageView {
		if m.MsgID == "" {
			continue
		}
		srcSlug := chainSlug(m.OriginChainID)

		if !m.IsDelivered || m.DeliveryOccurredAt == nil {
			// Count undelivered once and keep out of dedupe so we
			// observe the eventual delivered transition on later poll.
			if !seen.contains(m.MsgID) {
				hyperlaneUndeliveredTotal.WithLabelValues(srcSlug).Inc()
			}
			continue
		}
		if seen.contains(m.MsgID) {
			continue
		}
		sendTs, err1 := time.Parse(hyperlaneTimeLayout, m.SendOccurredAt)
		recvTs, err2 := time.Parse(hyperlaneTimeLayout, *m.DeliveryOccurredAt)
		if err1 != nil || err2 != nil {
			seen.add(m.MsgID)
			continue
		}
		deltaMs := float64(recvTs.Sub(sendTs).Milliseconds())
		if deltaMs < 0 || deltaMs > maxLatencyMs {
			seen.add(m.MsgID)
			continue
		}
		dstSlug := chainSlug(m.DestinationChainID)
		hyperlaneLatencyMs.WithLabelValues(srcSlug, dstSlug).Observe(deltaMs)
		hyperlaneSeenTotal.WithLabelValues(srcSlug, dstSlug).Inc()
		seen.add(m.MsgID)
		fresh++
	}
	hyperlaneDedupeCacheSize.Set(float64(seen.size()))
	log.Printf("poll: %d rows, %d fresh, dedupe=%d", len(parsed.Data.MessageView), fresh, seen.size())
	return nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("hyperlane-message-latency: starting")

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
		hyperlanePollErrors.Inc()
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
				hyperlanePollErrors.Inc()
			}
			mu.Unlock()
		case <-sig:
			log.Println("shutdown")
			return
		}
	}
}
