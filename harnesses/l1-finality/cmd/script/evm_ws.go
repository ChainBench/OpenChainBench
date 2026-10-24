package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
)

// EVM wall-clock finality measurement.
//
// Used for chains whose finality is faster than our HTTP poll interval
// (BNB ~1.5s, Avalanche ~1.5s). Comparing latest.timestamp vs
// finalized.timestamp at one poll instant doesn't measure finalization
// time — it measures the gap-at-poll-time, which collapses to 0 when
// finalization catches up to head. WS subscription lets us record the
// wall-clock time we first see block N as latest, then time-stamp again
// when N becomes finalized; lag = T2 - T1 with ms precision.

type wsChain struct {
	slug string
	url  string
	// batch: finality lands thousands of blocks at a time (rollups). The
	// gauge then carries the batch median, not the last block's lag, which
	// is always the smallest of the batch, and one log line per batch.
	batch bool
	// fromProposal: the chain's `latest` is already final, so time it from
	// the header's millisecond production timestamp to its arrival here.
	fromProposal bool
}

var wallClockChains = []wsChain{
	{slug: "bnb", url: "wss://bsc-rpc.publicnode.com"},
	// Avalanche C-Chain runs Streaming Asynchronous Execution (ACP-194)
	// since the 2026-09-22 ~15:00 UTC upgrade: `latest` is the last executed
	// block, already accepted and so final under Snowman, while `finalized`
	// is the last SETTLED block, tau = 5 s later. latest -> finalized jumped
	// from ~1.4 s to ~6 s that afternoon and measured the settlement delay,
	// a config constant. The figure is now block production
	// (timestampMilliseconds, proposer clock) -> first seen as latest.
	{slug: "avalanche", url: "wss://avalanche-c-chain-rpc.publicnode.com/ext/bc/C/ws", fromProposal: true},
	// Robinhood Chain (Arbitrum Orbit, ~100 ms blocks): `finalized` moves
	// when a posted batch is finalized on the parent chain, ~10,000 blocks
	// at a time. The official wss endpoint delivered no heads on 2026-10-24.
	{slug: "robinhood", url: "wss://robinhood-rpc.publicnode.com", batch: true},
}

var (
	wallClockLagGauge   *prometheus.GaugeVec
	wallClockLagSum     *prometheus.HistogramVec
	wallClockHealth     *prometheus.GaugeVec
	wallClockSampleCtr  *prometheus.CounterVec
)

func init() {
	wallClockLagGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finality_wallclock_lag_milliseconds",
			Help: "Wall-clock time, in milliseconds, between observing block N as latest and observing it as finalized. Sub-poll-cadence measurement via WS.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(wallClockLagGauge)

	wallClockLagSum = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "l1_finality_wallclock_lag_milliseconds_histogram",
			Help:    "Histogram of wall-clock finality lag samples per chain.",
			Buckets: []float64{50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, 30000},
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(wallClockLagSum)

	wallClockHealth = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "l1_finality_wallclock_health",
			Help: "1 if the WS subscription is currently connected and receiving events, 0 otherwise.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(wallClockHealth)

	wallClockSampleCtr = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "l1_finality_wallclock_samples_total",
			Help: "Number of finality samples observed per chain since process start.",
		},
		[]string{"chain"},
	)
	prometheus.MustRegister(wallClockSampleCtr)
}

type wsState struct {
	slug      string
	url       string
	mu        sync.Mutex
	firstSeen map[int64]time.Time
	batch     bool
	frozen    map[int64]time.Time // Solana only: slot fully received and replayed
	lastFinal int64
	idCtr     int
	conn      *websocket.Conn
}

type evmRPCReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type evmSubEvent struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method,omitempty"`
	ID      *int   `json:"id,omitempty"`
	Params  *struct {
		Subscription string `json:"subscription"`
		Result       struct {
			Number      string `json:"number"`
			Timestamp   string `json:"timestamp"`
			TimestampMs string `json:"timestampMilliseconds"`
		} `json:"result"`
	} `json:"params,omitempty"`
	Result *struct {
		Number    string `json:"number"`
		Timestamp string `json:"timestamp"`
	} `json:"result,omitempty"`
}

func parseHexInt(s string) int64 {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return 0
	}
	n, _ := strconv.ParseInt(s, 16, 64)
	return n
}

// StartWSFinality launches one persistent goroutine per WS-measured chain.
// Each goroutine reconnects on error with exponential backoff.
func StartWSFinality() {
	for _, ch := range wallClockChains {
		ch := ch
		go func() {
			backoff := 2 * time.Second
			for {
				err := runWSChain(ch)
				if err != nil {
					fmt.Printf("[L1][%s] WS error: %v (reconnecting in %v)\n", ch.slug, err, backoff)
					wallClockHealth.WithLabelValues(ch.slug).Set(0)
				}
				time.Sleep(backoff)
				if backoff < 60*time.Second {
					backoff *= 2
				}
			}
		}()
	}
}

func runWSChain(ch wsChain) error {
	conn, _, err := websocket.DefaultDialer.Dial(ch.url, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	st := &wsState{
		slug:      ch.slug,
		url:       ch.url,
		firstSeen: map[int64]time.Time{},
		batch:     ch.batch,
		conn:      conn,
	}

	st.idCtr++
	if err := st.writeJSON(evmRPCReq{
		JSONRPC: "2.0", ID: st.idCtr, Method: "eth_subscribe",
		Params: []any{"newHeads"},
	}); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	wallClockHealth.WithLabelValues(ch.slug).Set(1)
	fmt.Printf("[L1][%s] WS connected, subscribed to newHeads\n", ch.slug)

	stopPoll := make(chan struct{})
	defer close(stopPoll)
	go func() {
		if ch.fromProposal {
			return // `finalized` is not the figure on these chains
		}
		t := time.NewTicker(1 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopPoll:
				return
			case <-t.C:
				st.mu.Lock()
				st.idCtr++
				id := st.idCtr
				st.mu.Unlock()
				if err := st.writeJSON(evmRPCReq{
					JSONRPC: "2.0", ID: id, Method: "eth_getBlockByNumber",
					Params: []any{"finalized", false},
				}); err != nil {
					return
				}
			}
		}
	}()

	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))

		var ev evmSubEvent
		if err := json.Unmarshal(msg, &ev); err != nil {
			continue
		}
		if ev.Method == "eth_subscription" && ev.Params != nil {
			if ch.fromProposal {
				if lag, ok := proposalLag(ev.Params.Result.TimestampMs, time.Now()); ok {
					recordWallClock(ch.slug, lag)
				}
				continue
			}
			n := parseHexInt(ev.Params.Result.Number)
			if n > 0 {
				st.recordLatest(n)
			}
			continue
		}
		if ev.Result != nil {
			n := parseHexInt(ev.Result.Number)
			if n > 0 {
				st.recordFinal(n, time.Now())
			}
		}
	}
}

func (st *wsState) writeJSON(v any) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.conn.WriteJSON(v)
}

func (st *wsState) recordLatest(blockNum int64) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, ok := st.firstSeen[blockNum]; !ok {
		st.firstSeen[blockNum] = time.Now()
	}
}

func (st *wsState) recordFinal(blockNum int64, now time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if blockNum <= st.lastFinal {
		return
	}
	// First finalized reading after a (re)connect: nothing seen since the
	// connect can be at or below it, and walking from block 1 to the head
	// is ~100M map lookups under the lock.
	if st.lastFinal == 0 {
		st.lastFinal = blockNum
		return
	}
	var lags []float64
	for h := st.lastFinal + 1; h <= blockNum; h++ {
		if t, ok := st.firstSeen[h]; ok {
			lagMs := float64(now.Sub(t).Milliseconds())
			if lagMs >= 0 {
				wallClockLagSum.WithLabelValues(st.slug).Observe(lagMs)
				wallClockSampleCtr.WithLabelValues(st.slug).Inc()
				if st.batch {
					lags = append(lags, lagMs)
					continue
				}
				wallClockLagGauge.WithLabelValues(st.slug).Set(lagMs)
				fmt.Fprintf(os.Stdout, "[L1][%s] block=%d wall-clock-lag=%.0fms\n", st.slug, h, lagMs)
			}
		}
	}
	if len(lags) > 0 {
		sort.Float64s(lags)
		med := lags[len(lags)/2]
		wallClockLagGauge.WithLabelValues(st.slug).Set(med)
		fmt.Fprintf(os.Stdout, "[L1][%s] finalized=%d batch=%d blocks median-lag=%.0fms range=%.0f-%.0fms\n",
			st.slug, blockNum, len(lags), med, lags[0], lags[len(lags)-1])
	}
	st.lastFinal = blockNum

	for h := range st.firstSeen {
		if h < blockNum-1000 {
			delete(st.firstSeen, h)
		}
	}
}

// proposalLag is arrival minus the header's millisecond timestamp. Readings
// outside 0..60 s are clock skew or a stale replay, not finality.
func proposalLag(tsMsHex string, now time.Time) (float64, bool) {
	ms := parseHexInt(tsMsHex)
	if ms <= 0 {
		return 0, false
	}
	lag := float64(now.UnixMilli() - ms)
	if lag < 0 || lag > 60000 {
		return 0, false
	}
	return lag, true
}

func recordWallClock(slug string, lagMs float64) {
	wallClockLagGauge.WithLabelValues(slug).Set(lagMs)
	wallClockLagSum.WithLabelValues(slug).Observe(lagMs)
	wallClockSampleCtr.WithLabelValues(slug).Inc()
}
