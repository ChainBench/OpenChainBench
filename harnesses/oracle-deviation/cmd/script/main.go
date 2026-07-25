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
//
// TS is when WE fetched the value (wall-clock at the harness).
// SourceTS is the timestamp the source itself attached to the
// reading: Chainlink's on-chain updatedAt for the round, time.Now()
// for the continuously-updating sources (Pyth Hermes, Binance ticker,
// Coinbase ticker, which all publish "current" prices at fetch time).
// The gap (TS - SourceTS) is what oracleLastRoundAge surfaces.
type pricePoint struct {
	Value    float64
	TS       time.Time
	SourceTS time.Time
}

var (
	storeMu sync.RWMutex
	// store[pair][source] = pricePoint
	store = make(map[Pair]map[Source]pricePoint)

	// Rolling per-(pair, source) history. Used by the time-aligned
	// deviation calculation: when Chainlink's SourceTS is 20 min
	// older than its TS, we compare its price against the OTHER
	// sources' historical prices at that same SourceTS, not against
	// their current values. Eliminates the clock-skew artifact that
	// inflates "deviation" by the market's drift during Chainlink's
	// heartbeat window. Bounded by historyDepth; pruned on insert.
	historyMu sync.RWMutex
	history   = make(map[Pair]map[Source][]pricePoint)
)

const (
	// 60 entries × 30s cadence ≈ 30 min look-back. Larger than any
	// reasonable alignment tolerance, smaller than the time scales
	// at which a deviation > 10% off a 20 min Chainlink lag would
	// stop being interesting.
	historyDepth = 60
	// Window around the anchor timestamp we search when looking up
	// a corresponding price on another source. 10 s = ~1/3 of the
	// 30 s polling cadence, so a healthy source should always have
	// at least one sample inside the window. Misses are counted as
	// oracleAlignmentMiss.
	alignTolerance = 10 * time.Second
)

// recordPrice is called by every continuously-updating poller (Pyth,
// Binance, Coinbase) after a successful read. SourceTS is set to
// time.Now() because these sources publish current prices, no on-chain
// timestamp gap. Chainlink calls recordPriceAt instead so it can pass
// the on-chain updatedAt as SourceTS.
func recordPrice(src Source, pair Pair, v float64) {
	recordPriceAt(src, pair, v, time.Now())
}

// recordPriceAt is the underlying primitive. sourceTS is when the
// source itself declared the price current (Chainlink updatedAt for
// chainlink, fetch time for the others). The (TS, SourceTS) pair is
// what the time-aligned deviation calculation needs to compare prices
// at the same reference moment instead of at fetch time.
func recordPriceAt(src Source, pair Pair, v float64, sourceTS time.Time) {
	if v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		// Defensive: a 0 or NaN price would poison the deviation calc.
		// Count it as an error and bail.
		oracleScrapeErrors.WithLabelValues(string(src), string(pair)).Inc()
		return
	}
	now := time.Now()
	point := pricePoint{Value: v, TS: now, SourceTS: sourceTS}

	storeMu.Lock()
	if _, ok := store[pair]; !ok {
		store[pair] = make(map[Source]pricePoint)
	}
	store[pair][src] = point
	storeMu.Unlock()

	// Append to the rolling history under the SourceTS the source
	// gave us, prune anything older than the depth. This is what
	// the at_oracle_ts deviation calc reads from.
	historyMu.Lock()
	if _, ok := history[pair]; !ok {
		history[pair] = make(map[Source][]pricePoint)
	}
	h := append(history[pair][src], point)
	if len(h) > historyDepth {
		h = h[len(h)-historyDepth:]
	}
	history[pair][src] = h
	historyMu.Unlock()

	oraclePrice.WithLabelValues(string(src), string(pair)).Set(v)
	oracleUpdateLatencySeconds.WithLabelValues(string(src), string(pair)).Set(0)
	recomputeDeviations(pair)
}

// lookupNearest returns the pricePoint for (pair, src) whose SourceTS
// is nearest to target, within ±alignTolerance. Returns ok=false when
// no such sample exists. Caller does not need to hold any lock; this
// acquires historyMu.RLock internally.
func lookupNearest(pair Pair, src Source, target time.Time) (pricePoint, bool) {
	historyMu.RLock()
	defer historyMu.RUnlock()
	byPair := history[pair]
	if byPair == nil {
		return pricePoint{}, false
	}
	samples := byPair[src]
	if len(samples) == 0 {
		return pricePoint{}, false
	}
	var best pricePoint
	bestDelta := time.Duration(1<<62 - 1)
	found := false
	for _, p := range samples {
		delta := p.SourceTS.Sub(target)
		if delta < 0 {
			delta = -delta
		}
		if delta > alignTolerance {
			continue
		}
		if delta < bestDelta {
			best = p
			bestDelta = delta
			found = true
		}
	}
	if !found {
		return pricePoint{}, false
	}
	return best, true
}

// recomputeDeviations computes pairwise + max deviations for one
// pair. Called inline from recordPrice so the metrics always reflect
// the freshest data.
//
// Publishes TWO families of deviation gauges:
//
//   - ocb_oracle_deviation_at_fetch_ts_pct (and the legacy alias
//     ocb_oracle_deviation_pct): pairwise deviation using whatever
//     each source last reported, regardless of when each source
//     declared its price current. This is the operational truth a
//     protocol team sees if it just polls all four sources right
//     now. Useful for showing the gap between "what Chainlink has
//     on-chain right now" and "what the live CEX/Pyth print is."
//
//   - ocb_oracle_deviation_at_oracle_ts_pct: time-aligned deviation.
//     For every (source_a, source_b) pair, snap both prices to the
//     more recent SourceTS of the two and look up the older
//     source's price in its rolling history at THAT moment. This is
//     the deviation a researcher needs to grade oracle quality at
//     update time, free of the artifact that Chainlink's heartbeat
//     introduces when its updatedAt is 20 min behind the others.
//
// Headline ocb_oracle_max_deviation_pct ranks on the at_oracle_ts
// variant because that's the canonical question: how aligned are
// the oracles when you compare like for like. The at_fetch_ts series
// remains queryable for backward compatibility with anyone who built
// a dashboard on the legacy gauge.
//
// Methodology recommendation from Coinpaprika data team review. See
// also Chaos Labs and Risk DAO's published methodology — both snap
// market price to the oracle's updatedAt block timestamp, not the
// fetch time.
func recomputeDeviations(pair Pair) {
	storeMu.RLock()
	srcMap := store[pair]
	type srcSample struct {
		value    float64
		sourceTS time.Time
	}
	samples := make(map[Source]srcSample, len(srcMap))
	for s, p := range srcMap {
		// Skip stale prices (>2 polling intervals = 60s) when
		// recomputing — otherwise a dead source would keep its last
		// value frozen and quietly bias the deviation forever.
		if time.Since(p.TS) > 2*pollInterval {
			continue
		}
		samples[s] = srcSample{value: p.Value, sourceTS: p.SourceTS}
	}
	storeMu.RUnlock()

	if len(samples) < 2 {
		return
	}

	// Sort sources lexicographically to keep the (source_a, source_b)
	// label deterministic regardless of map iteration order.
	srcs := make([]Source, 0, len(samples))
	for s := range samples {
		srcs = append(srcs, s)
	}
	sort.Slice(srcs, func(i, j int) bool { return srcs[i] < srcs[j] })

	maxFetchDev := 0.0
	maxAlignedDev := 0.0
	haveAligned := false
	for i := 0; i < len(srcs); i++ {
		for j := i + 1; j < len(srcs); j++ {
			a, b := samples[srcs[i]], samples[srcs[j]]
			mid := (a.value + b.value) / 2
			if mid == 0 {
				continue
			}

			// Fetch-time pairwise deviation: current behavior,
			// preserved as the legacy gauge + a new explicit alias.
			fetchDev := math.Abs(a.value-b.value) / mid * 100
			oracleDeviationPct.WithLabelValues(string(pair), string(srcs[i]), string(srcs[j])).Set(fetchDev)
			oracleDeviationAtFetchTSPct.WithLabelValues(string(pair), string(srcs[i]), string(srcs[j])).Set(fetchDev)
			if fetchDev > maxFetchDev {
				maxFetchDev = fetchDev
			}

			// Time-aligned pairwise deviation: anchor on the more
			// recent SourceTS, look up the other side in history.
			anchor := a.sourceTS
			if b.sourceTS.After(anchor) {
				anchor = b.sourceTS
			}
			alignedA, okA := alignedPriceAt(pair, srcs[i], a, anchor)
			alignedB, okB := alignedPriceAt(pair, srcs[j], b, anchor)
			if !okA || !okB {
				oracleAlignmentMiss.WithLabelValues(string(pair), string(srcs[i]), string(srcs[j])).Inc()
				continue
			}
			alignedMid := (alignedA + alignedB) / 2
			if alignedMid == 0 {
				continue
			}
			alignedDev := math.Abs(alignedA-alignedB) / alignedMid * 100
			oracleDeviationAtOracleTSPct.WithLabelValues(string(pair), string(srcs[i]), string(srcs[j])).Set(alignedDev)
			if alignedDev > maxAlignedDev {
				maxAlignedDev = alignedDev
			}
			haveAligned = true
		}
	}

	// Headline ranks on the time-aligned max when at least one
	// aligned pair was computable, otherwise we fall back on the
	// fetch-time max (matches old behavior so the gauge never goes
	// dark during a buffer cold-start window).
	if haveAligned {
		oracleMaxDeviationPct.WithLabelValues(string(pair)).Set(maxAlignedDev)
	} else {
		oracleMaxDeviationPct.WithLabelValues(string(pair)).Set(maxFetchDev)
	}
}

// alignedPriceAt returns the price the given source had at "anchor"
// time, with fallback to the current sample when source's own SourceTS
// is already at anchor (within tolerance, no history lookup needed).
// Returns ok=false when no historical sample exists within tolerance.
func alignedPriceAt(pair Pair, src Source, cur struct {
	value    float64
	sourceTS time.Time
}, anchor time.Time) (float64, bool) {
	delta := cur.sourceTS.Sub(anchor)
	if delta < 0 {
		delta = -delta
	}
	if delta <= alignTolerance {
		return cur.value, true
	}
	p, ok := lookupNearest(pair, src, anchor)
	if !ok {
		return 0, false
	}
	return p.Value, true
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
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Oracle Deviation Harness ===")
	fmt.Println("OpenChainBench № 025 — 4 oracles × 10 pairs, max deviation gauge.")
	fmt.Println("OpenChainBench № 082 — oracle freshness (chainlink eth/arb/base, pyth hermes, redstone gateway).")
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
	// :2112 is the OCB convention (see top-of-file comment). The env
	// override exists for LOCAL runs only, e.g. when another process
	// already holds 2112 on a dev machine. Never set it in production.
	metricsAddr := envDefault("ORACLE_METRICS_ADDR", ":2112")
	fmt.Printf("Poll cadence: %s per source per pair\n", pollInterval)
	fmt.Printf("Metrics server: %s/metrics\n", metricsAddr)
	fmt.Println()

	go func() {
		if err := StartMetricsServer(metricsAddr); err != nil {
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

	// № 082 freshness-only pollers. Kept out of the deviation store by
	// construction (see ChainFeed / runRedstone docs).
	go runChainlinkChains(ctx, extraChainlinkFeeds())
	go runRedstone(ctx, redstoneFeeds())
	go runFreshnessUpdater(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}
