package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/signal"
	"sort"
	"sync"
	"syscall"
	"time"
)

// Metrics server listens on :2112 — the OCB convention for every
// harness scraped by the shared Prometheus at
// <service>.railway.internal:2112. We deliberately ignore Railway's
// $PORT injection so a public port assignment doesn't move the
// listener away from where Prometheus expects it.

// pricePoint is the in-memory record per (pair, source). The whole
// store fits in 4 sources × 10 pairs = 40 entries, so we don't need
// a real DB — a guarded map is more than enough.
type pricePoint struct {
	Value float64
	TS    time.Time
}

var (
	storeMu sync.RWMutex
	// store[pair][source] = pricePoint
	store = make(map[Pair]map[Source]pricePoint)
)

// recordPrice is called by every poller after a successful read.
// Updates the in-memory store + the per-source gauge + the per-pair
// deviation matrix.
func recordPrice(src Source, pair Pair, v float64) {
	if v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		// Defensive: a 0 or NaN price would poison the deviation calc.
		// Count it as an error and bail.
		oracleScrapeErrors.WithLabelValues(string(src), string(pair)).Inc()
		return
	}
	now := time.Now()
	storeMu.Lock()
	if _, ok := store[pair]; !ok {
		store[pair] = make(map[Source]pricePoint)
	}
	store[pair][src] = pricePoint{Value: v, TS: now}
	storeMu.Unlock()

	oraclePrice.WithLabelValues(string(src), string(pair)).Set(v)
	oracleUpdateLatencySeconds.WithLabelValues(string(src), string(pair)).Set(0)
	recomputeDeviations(pair)
}

// recomputeDeviations computes pairwise + max deviations for one
// pair. Called inline from recordPrice so the metrics always reflect
// the freshest data.
func recomputeDeviations(pair Pair) {
	storeMu.RLock()
	srcMap := store[pair]
	prices := make(map[Source]float64, len(srcMap))
	for s, p := range srcMap {
		// Skip stale prices (>2 polling intervals = 60s) when
		// recomputing — otherwise a dead source would keep its last
		// value frozen and quietly bias the deviation forever.
		if time.Since(p.TS) > 2*pollInterval {
			continue
		}
		prices[s] = p.Value
	}
	storeMu.RUnlock()

	if len(prices) < 2 {
		return
	}

	// Sort sources lexicographically to keep the (source_a, source_b)
	// label deterministic regardless of map iteration order.
	srcs := make([]Source, 0, len(prices))
	for s := range prices {
		srcs = append(srcs, s)
	}
	sort.Slice(srcs, func(i, j int) bool { return srcs[i] < srcs[j] })

	maxDev := 0.0
	for i := 0; i < len(srcs); i++ {
		for j := i + 1; j < len(srcs); j++ {
			a, b := prices[srcs[i]], prices[srcs[j]]
			mid := (a + b) / 2
			if mid == 0 {
				continue
			}
			dev := math.Abs(a-b) / mid * 100
			oracleDeviationPct.WithLabelValues(string(pair), string(srcs[i]), string(srcs[j])).Set(dev)
			if dev > maxDev {
				maxDev = dev
			}
		}
	}
	oracleMaxDeviationPct.WithLabelValues(string(pair)).Set(maxDev)
}

// runLatencyUpdater bumps the update_latency_seconds gauge once per
// second so a stalled poller is visible without waiting for the next
// successful read. Cheap: 40 gauges to touch each tick.
func runLatencyUpdater(ctx context.Context) {
	t := time.NewTicker(1 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			storeMu.RLock()
			for pair, srcMap := range store {
				for src, p := range srcMap {
					age := now.Sub(p.TS).Seconds()
					oracleUpdateLatencySeconds.WithLabelValues(string(src), string(pair)).Set(age)
				}
			}
			storeMu.RUnlock()
		}
	}
}

func main() {
	fmt.Println("=== Oracle Deviation Harness ===")
	fmt.Println("OpenChainBench № 025 — 4 oracles × 10 pairs, max deviation gauge.")
	fmt.Println()

	specs := pairs()
	fmt.Printf("Pairs (%d):\n", len(specs))
	for _, s := range specs {
		fmt.Printf("  - %-9s  chainlink=%s  pyth=%s  binance=%s  coinbase=%s\n",
			s.Pair, s.ChainlinkFeed, s.PythID[:10]+"…", s.BinanceSymbol, s.CoinbaseProduct)
	}
	fmt.Println()
	fmt.Printf("RPC primary:  %s\n", rpcEndpoint())
	fmt.Printf("RPC fallback: %s\n", rpcEndpointFallback())
	fmt.Printf("Poll cadence: %s per source per pair\n", pollInterval)
	fmt.Println("Metrics server: :2112/metrics")
	fmt.Println()

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go runChainlink(ctx, specs)
	go runPyth(ctx, specs)
	go runBinance(ctx, specs)
	go runCoinbase(ctx, specs)
	go runLatencyUpdater(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}
