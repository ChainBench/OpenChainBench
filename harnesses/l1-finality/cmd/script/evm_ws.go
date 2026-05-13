package main

import (
	"encoding/json"
	"fmt"
	"os"
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
}

var wallClockChains = []wsChain{
	{slug: "bnb", url: "wss://bsc-rpc.publicnode.com"},
	{slug: "avalanche", url: "wss://avalanche-c-chain-rpc.publicnode.com/ext/bc/C/ws"},
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
			Number    string `json:"number"`
			Timestamp string `json:"timestamp"`
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
	for h := st.lastFinal + 1; h <= blockNum; h++ {
		if t, ok := st.firstSeen[h]; ok {
			lagMs := float64(now.Sub(t).Milliseconds())
			if lagMs >= 0 {
				wallClockLagGauge.WithLabelValues(st.slug).Set(lagMs)
				wallClockLagSum.WithLabelValues(st.slug).Observe(lagMs)
				wallClockSampleCtr.WithLabelValues(st.slug).Inc()
				fmt.Fprintf(os.Stdout, "[L1][%s] block=%d wall-clock-lag=%.0fms\n", st.slug, h, lagMs)
			}
		}
	}
	st.lastFinal = blockNum

	for h := range st.firstSeen {
		if h < blockNum-1000 {
			delete(st.firstSeen, h)
		}
	}
}
