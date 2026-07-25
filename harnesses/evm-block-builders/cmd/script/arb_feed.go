package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Arbitrum sequencer feed soft-confirmation lag.
//
// The sequencer feed (wss://arb1.arbitrum.io/feed) streams every L2
// message the sequencer accepts, seconds before the block is queryable
// on a public RPC. That gap IS the soft-confirmation advantage: trading
// systems reading the feed act on state that RPC users haven't seen
// yet. We hold the feed open, timestamp each message's arrival keyed by
// sequence number, poll the public RPC head, and emit the feed→RPC
// visibility lag as a histogram.
//
// Feed sequenceNumber → L2 block number is a FIXED offset (genesis
// alignment; 22207817 at inception) but we derive it at runtime instead
// of hardcoding. Per calibration poll we sample cand = rpcHead -
// latestFeedSeq. While the feed is live, cand is trueOffset minus the
// 0-1 blocks in flight between feed and RPC (lag ~0.1s vs 0.25s block
// time), so trueOffset is the LARGEST frequently-seen candidate. A
// plain max is NOT safe: on connect the feed replays a short backlog,
// latestSeq briefly trails the chain, and cand overshoots (observed
// +3 → every lag inflated by ~750ms). We therefore ignore the first
// polls after the feed goes live and pick the highest candidate with
// meaningful support. The derived value is logged and exported
// (ebb_arb_derived_offset) so drift would be visible.

const (
	arbDialTimeout   = 15 * time.Second
	arbReadDeadline  = 60 * time.Second
	arbWatchdog      = 30 * time.Second
	arbMinBackoff    = 2 * time.Second
	arbMaxBackoff    = 60 * time.Second
	arbCalibSamples  = 60 // ~18s of head polls before freezing the offset
	arbCalibWarmup   = 10 // polls to discard while the feed drains its connect backlog
	arbMaxLagSeconds = 30 // sanity bound: drop reconnect-gap outliers
	arrivalsMax      = 4000
)

type arbFeedState struct {
	mu        sync.Mutex
	arrivals  map[int64]time.Time // seq → first feed arrival
	order     []int64             // insertion order, for bounded pruning
	latestSeq int64
}

func newArbFeedState() *arbFeedState {
	return &arbFeedState{arrivals: make(map[int64]time.Time, arrivalsMax)}
}

func (s *arbFeedState) record(seq int64, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.arrivals[seq]; dup {
		return // only first arrival counts
	}
	s.arrivals[seq] = at
	s.order = append(s.order, seq)
	if seq > s.latestSeq {
		s.latestSeq = seq
	}
	for len(s.order) > arrivalsMax {
		delete(s.arrivals, s.order[0])
		s.order = s.order[1:]
	}
}

func (s *arbFeedState) lookup(seq int64) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.arrivals[seq]
	return t, ok
}

func (s *arbFeedState) latest() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.latestSeq
}

// arbFeedMsg is the minimal shape of a broadcast frame:
//
//	{"version":1,"messages":[{"sequenceNumber":296300000,"message":{...}}]}
type arbFeedMsg struct {
	Messages []struct {
		SequenceNumber int64 `json:"sequenceNumber"`
	} `json:"messages"`
}

// runArbFeed holds the sequencer feed WS open (reconnect loop with
// backoff + silence watchdog, same pattern as l2-block-time).
func runArbFeed(ctx context.Context, state *arbFeedState) {
	url := arbFeedURL()
	fmt.Printf("[arb-feed] connecting %s\n", url)
	backoff := arbMinBackoff
	for ctx.Err() == nil {
		connStart := time.Now()
		err := readArbFeed(ctx, url, state)
		if time.Since(connStart) > 5*time.Minute {
			backoff = arbMinBackoff // stable session: don't carry stale backoff
		}
		arbFeedHealth.Set(0)
		streamReconnects.WithLabelValues("arb-feed").Inc()
		if err != nil {
			fmt.Printf("[arb-feed] error: %v (reconnecting in %v)\n", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < arbMaxBackoff {
			backoff *= 2
			if backoff > arbMaxBackoff {
				backoff = arbMaxBackoff
			}
		}
	}
}

func readArbFeed(ctx context.Context, url string, state *arbFeedState) error {
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = arbDialTimeout
	hdr := http.Header{"User-Agent": []string{harnessUserAgent}}
	conn, _, err := dialer.Dial(url, hdr)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	arbFeedHealth.Set(1)
	fmt.Println("[arb-feed] connected")

	// Silence watchdog: Arbitrum produces ~4 blocks/s, so 30s without a
	// frame is unambiguously a wedged subscription. Atomic keeps the
	// watchdog lock-free (same pattern as l2-block-time's head watchdog).
	done := make(chan struct{})
	defer close(done)
	var lastMsgUnixNano atomic.Int64
	lastMsgUnixNano.Store(time.Now().UnixNano())
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				_ = conn.Close()
				return
			case now := <-t.C:
				silent := now.Sub(time.Unix(0, lastMsgUnixNano.Load()))
				if silent > arbWatchdog {
					fmt.Printf("[arb-feed] watchdog: silent %s, forcing reconnect\n", silent.Round(time.Second))
					_ = conn.Close()
					return
				}
			}
		}
	}()

	for {
		_ = conn.SetReadDeadline(time.Now().Add(arbReadDeadline))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		now := time.Now()
		lastMsgUnixNano.Store(now.UnixNano())

		var msg arbFeedMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue // keepalive / non-broadcast frame
		}
		for _, m := range msg.Messages {
			if m.SequenceNumber > 0 {
				state.record(m.SequenceNumber, now)
				arbFeedMessages.Inc()
			}
		}
	}
}

// runArbHeadPoller polls the Arbitrum RPC head, derives the
// seq→blockNumber offset during calibration, then emits the feed→RPC
// soft-confirmation lag for every head advance.
func runArbHeadPoller(ctx context.Context, state *arbFeedState) {
	url := arbRPCURL()
	fmt.Printf("[arb-rpc] head poll: %s every %s\n", url, l2HeadPollInterval)

	var (
		offset     int64
		warmup     int
		candidates = map[int64]int{}
		calibCount int
		calibrated bool
		prevHead   int64
	)
	t := time.NewTicker(l2HeadPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}

		head, err := blockNumber(url)
		if err != nil {
			arbRPCErrors.Inc()
			continue
		}
		pollAt := time.Now()
		latestSeq := state.latest()
		if latestSeq == 0 {
			continue // feed not live yet
		}

		if !calibrated {
			// Discard the first polls after the feed goes live: the connect
			// backlog replay makes latestSeq briefly trail the chain, which
			// would overshoot the offset (and inflate every lag sample).
			if warmup < arbCalibWarmup {
				warmup++
				continue
			}
			candidates[head-latestSeq]++
			calibCount++
			if calibCount >= arbCalibSamples {
				// Highest candidate with real support (>= 20% of samples).
				// Live-feed candidates cluster on trueOffset and
				// trueOffset-1 (0-1 blocks in flight); transient overshoots
				// have negligible counts and are rejected here.
				minSupport := calibCount / 5
				for cand, n := range candidates {
					if n >= minSupport && cand > offset {
						offset = cand
					}
				}
				if offset <= 0 {
					// No candidate reached support (feed stalled mid-window,
					// so cand drifted and the counts spread out). Locking
					// offset=0 would silence the lag histogram forever;
					// discard the window and re-calibrate instead.
					fmt.Printf("[arb-rpc] calibration failed (no candidate with >=%d support over %d samples), retrying\n", minSupport, calibCount)
					candidates = map[int64]int{}
					calibCount = 0
					warmup = 0
					continue
				}
				calibrated = true
				prevHead = head
				arbDerivedOffset.Set(float64(offset))
				fmt.Printf("[arb-rpc] calibrated seq→block offset=%d over %d samples (expected ≈22207817)\n", offset, calibCount)
			}
			continue
		}

		if head <= prevHead {
			continue
		}
		for b := prevHead + 1; b <= head; b++ {
			arrival, ok := state.lookup(b - offset)
			if !ok {
				continue
			}
			lagMs := float64(pollAt.Sub(arrival).Milliseconds())
			if lagMs >= 0 && lagMs < arbMaxLagSeconds*1000 {
				arbSoftConfLag.Observe(lagMs)
				arbLagSamples.Inc()
				fmt.Printf("[arb] block=%d softconf lag=%.0fms\n", b, lagMs)
			}
		}
		prevHead = head
	}
}
