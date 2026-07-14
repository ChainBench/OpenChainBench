package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/gorilla/websocket"
)

// Base flashblocks (preconfirmation) stream.
//
// wss://mainnet.flashblocks.base.org/ws pushes one frame per flashblock
// (~every 200-250ms; ~10 flashblocks per 2s Base block). Frames are
// binary, brotli-compressed JSON of the shape:
//
//	{"payload_id":"0x..","index":3,"base":{...},"diff":{...},
//	 "metadata":{"block_number":31234567,"receipts":{...},...}}
//
// Two measurements:
//  1. inter-frame cadence (ebb_base_flashblock_interval_milliseconds):
//     is the advertised 200ms preconfirmation rhythm actually held?
//  2. soft-confirmation lag (ebb_base_softconf_lag_milliseconds): time
//     from the FIRST flashblock of block N arriving on the stream to
//     block N being visible on the public RPC head. This is the head
//     start a flashblock consumer gets over an RPC poller.
//
// If a frame fails brotli+JSON parsing we still record cadence (the
// frame arrived) and count a parse failure; cadence-only degradation is
// acceptable and disclosed.

const (
	baseDialTimeout  = 15 * time.Second
	baseReadDeadline = 60 * time.Second
	baseWatchdog     = 20 * time.Second
	baseMinBackoff   = 2 * time.Second
	baseMaxBackoff   = 60 * time.Second
	baseMaxLagMs     = 30 * 1000
	// A reconnect gap must not pollute the cadence histogram.
	baseMaxIntervalMs = 10 * 1000
	baseArrivalsMax   = 200
)

type baseFeedState struct {
	mu       sync.Mutex
	arrivals map[int64]time.Time // block number → first flashblock arrival
	order    []int64
}

func newBaseFeedState() *baseFeedState {
	return &baseFeedState{arrivals: make(map[int64]time.Time, baseArrivalsMax)}
}

func (s *baseFeedState) recordFirst(block int64, at time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.arrivals[block]; dup {
		return false
	}
	s.arrivals[block] = at
	s.order = append(s.order, block)
	for len(s.order) > baseArrivalsMax {
		delete(s.arrivals, s.order[0])
		s.order = s.order[1:]
	}
	return true
}

func (s *baseFeedState) lookup(block int64) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.arrivals[block]
	return t, ok
}

type flashblockFrame struct {
	Index    *int64 `json:"index"`
	Metadata struct {
		BlockNumber int64 `json:"block_number"`
	} `json:"metadata"`
}

// runBaseFlashblocks holds the flashblocks WS open with reconnect
// backoff + silence watchdog and feeds cadence + arrival state.
func runBaseFlashblocks(ctx context.Context, state *baseFeedState) {
	url := baseFlashblocksURL()
	fmt.Printf("[base-fb] connecting %s\n", url)
	backoff := baseMinBackoff
	for ctx.Err() == nil {
		err := readBaseFlashblocks(ctx, url, state)
		baseFeedHealth.Set(0)
		streamReconnects.WithLabelValues("base-flashblocks").Inc()
		if err != nil {
			fmt.Printf("[base-fb] error: %v (reconnecting in %v)\n", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < baseMaxBackoff {
			backoff *= 2
			if backoff > baseMaxBackoff {
				backoff = baseMaxBackoff
			}
		}
	}
}

func readBaseFlashblocks(ctx context.Context, url string, state *baseFeedState) error {
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = baseDialTimeout
	hdr := http.Header{"User-Agent": []string{harnessUserAgent}}
	conn, _, err := dialer.Dial(url, hdr)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	baseFeedHealth.Set(1)
	fmt.Println("[base-fb] connected")

	done := make(chan struct{})
	defer close(done)
	var lastFrameUnixNano atomic.Int64
	lastFrameUnixNano.Store(time.Now().UnixNano())
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				_ = conn.Close()
				return
			case now := <-t.C:
				silent := now.Sub(time.Unix(0, lastFrameUnixNano.Load()))
				if silent > baseWatchdog {
					fmt.Printf("[base-fb] watchdog: silent %s, forcing reconnect\n", silent.Round(time.Second))
					_ = conn.Close()
					return
				}
			}
		}
	}()

	var lastFrame time.Time
	logEvery := 0
	for {
		_ = conn.SetReadDeadline(time.Now().Add(baseReadDeadline))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		now := time.Now()
		lastFrameUnixNano.Store(now.UnixNano())

		// Cadence: frame arrival rhythm, parse success or not.
		if !lastFrame.IsZero() {
			ivMs := float64(now.Sub(lastFrame).Milliseconds())
			if ivMs >= 0 && ivMs < baseMaxIntervalMs {
				baseFlashblockInterval.Observe(ivMs)
			}
		}
		lastFrame = now
		baseFrames.Inc()

		frame, err := decodeFlashblockFrame(raw)
		if err != nil {
			baseParseFailures.Inc()
			continue
		}
		if frame.Metadata.BlockNumber > 0 {
			if state.recordFirst(frame.Metadata.BlockNumber, now) {
				logEvery++
				if logEvery%10 == 1 { // ~1 log line per 20s, not per 200ms frame
					idx := int64(-1)
					if frame.Index != nil {
						idx = *frame.Index
					}
					fmt.Printf("[base-fb] first flashblock block=%d index=%d\n", frame.Metadata.BlockNumber, idx)
				}
			}
		}
	}
}

// decodeFlashblockFrame handles both brotli-compressed and plain-JSON
// frames (the stream compressed at inception; tolerate both so a
// server-side change doesn't blind the bench).
func decodeFlashblockFrame(raw []byte) (*flashblockFrame, error) {
	var frame flashblockFrame
	if len(raw) > 0 && (raw[0] == '{' || raw[0] == '[') {
		if err := json.Unmarshal(raw, &frame); err == nil {
			return &frame, nil
		}
	}
	dec, err := io.ReadAll(io.LimitReader(brotli.NewReader(bytes.NewReader(raw)), 16<<20))
	if err != nil {
		return nil, fmt.Errorf("brotli: %w", err)
	}
	if err := json.Unmarshal(dec, &frame); err != nil {
		return nil, fmt.Errorf("json: %w", err)
	}
	return &frame, nil
}

// runBaseHeadPoller polls the Base RPC head and emits the
// flashblock→canonical-RPC soft-confirmation lag.
func runBaseHeadPoller(ctx context.Context, state *baseFeedState) {
	url := baseRPCURL()
	fmt.Printf("[base-rpc] head poll: %s every %s\n", url, l2HeadPollInterval)

	var prevHead int64
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
			baseRPCErrors.Inc()
			continue
		}
		pollAt := time.Now()
		if prevHead == 0 {
			prevHead = head
			continue
		}
		for b := prevHead + 1; b <= head; b++ {
			arrival, ok := state.lookup(b)
			if !ok {
				continue
			}
			lagMs := float64(pollAt.Sub(arrival).Milliseconds())
			if lagMs >= 0 && lagMs < baseMaxLagMs {
				baseSoftConfLag.Observe(lagMs)
				baseLagSamples.Inc()
				fmt.Printf("[base] block=%d softconf lag=%.0fms\n", b, lagMs)
			}
		}
		if head > prevHead {
			prevHead = head
		}
	}
}
