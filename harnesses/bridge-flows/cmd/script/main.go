package main

// bridge-flows: where USDC moves between chains, from public data only.
//
//   - Circle CCTP burns (DepositForBurn v1 and v2) read off each scanned
//     chain's TokenMessenger contracts over free RPCs, bucketed per hour
//     and per destination domain, persisted under /data.
//   - Wormhole outbound volume per chain per UTC day from Wormholescan.
//   - L2Beat TVS (canonical plus external) deltas per L2.
//
// It feeds bench usdc-corridor-flows and publishes on :2112/metrics.

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func main() {
	installLogCapture()
	cfg := loadConfig()
	fmt.Println("=== bridge-flows harness ===")
	fmt.Printf("chains=%d tick=%s state=%s history=%dh\n", len(cfg.Chains), cfg.Tick, cfg.StateFile, cfg.HistoryHours)
	fmt.Printf("cctp topics v1=%s v2=%s\n", topicV1, topicV2)

	state, err := loadState(cfg.StateFile)
	if err != nil {
		log.Fatalf("state: %v", err)
	}
	go func() {
		if err := startMetricsServer(cfg.Addr); err != nil {
			log.Fatalf("metrics server: %v", err)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	scanners := make([]*scanner, 0, len(cfg.Chains))
	for _, c := range cfg.Chains {
		scanners = append(scanners, newScanner(c, cfg.RequestGap, state))
	}

	go loop(ctx, cfg.WormholeEvery, func() {
		if err := pollWormhole(ctx); err != nil {
			log.Printf("[wormhole] %v", err)
		}
	})
	go loop(ctx, cfg.L2BeatEvery, func() { pollL2Beat(ctx, cfg.Chains) })
	go loop(ctx, cfg.Tick, func() {
		tick(ctx, cfg, scanners, state)
	})

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down")
	cancel()
	_ = state.save()
}

func loop(ctx context.Context, every time.Duration, f func()) {
	f()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

// tick scans every source chain, then republishes the corridor windows.
func tick(ctx context.Context, cfg Config, scanners []*scanner, state *State) {
	start := time.Now()
	healthy := map[string]bool{}
	for _, s := range scanners {
		if ctx.Err() != nil {
			return
		}
		n, err := s.scan(ctx, cfg.HistoryHours)
		head, herr := s.rpc.blockNumber(ctx)
		if herr == nil {
			sourceLag.WithLabelValues(s.chain.Slug).Set(float64(head - state.cursor(s.chain.Slug)))
		}
		if err != nil {
			log.Printf("[%s] scan: %v (folded %d before the error)", s.chain.Slug, err, n)
			sourceCovered.WithLabelValues(s.chain.Slug).Set(0)
			continue
		}
		healthy[s.chain.Slug] = true
		sourceCovered.WithLabelValues(s.chain.Slug).Set(1)
		if n > 0 {
			log.Printf("[%s] folded %d burns, cursor %d", s.chain.Slug, n, state.cursor(s.chain.Slug))
		}
	}
	if err := state.save(); err != nil {
		log.Printf("state save: %v", err)
	}
	publish(cfg, state, healthy)
	lastTick.Set(float64(time.Now().Unix()))
	log.Printf("[tick] %d/%d chains healthy, %s", len(healthy), len(scanners), time.Since(start).Round(time.Second))
}

// publish rebuilds the window gauges. A chain whose scan failed keeps its
// previous gauge values (nothing is set for it), so a stalled RPC never
// reads as zero flow.
func publish(cfg Config, state *State, healthy map[string]bool) {
	windows := map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour}
	for window, d := range windows {
		inbound := map[string]float64{}
		outTotal := map[string]float64{}
		for _, c := range cfg.Chains {
			if !healthy[c.Slug] {
				continue
			}
			usd, burns := state.window(c.Slug, d)
			var total float64
			var nb int
			for dom, v := range usd {
				dest, ok := domainSlug[dom]
				if !ok {
					dest = "domain-" + strconv.FormatUint(uint64(dom), 10)
				}
				usdcOut.WithLabelValues(c.Slug, dest, window).Set(v)
				inbound[dest] += v
				total += v
				nb += burns[dom]
			}
			outTotal[c.Slug] = total
			usdcOutTotal.WithLabelValues(c.Slug, window).Set(total)
			usdcBurns.WithLabelValues(c.Slug, window).Set(float64(nb))
		}
		// Inbound is only complete for the scanned cohort's own burns, and
		// only meaningful as a net figure for chains that are themselves
		// scanned (their outflow is known). Every scanned chain must be
		// healthy for the inbound sums to be whole; otherwise skip the
		// window rather than publish a partial inbound as if complete.
		if len(healthy) != len(cfg.Chains) {
			continue
		}
		for dest, v := range inbound {
			usdcIn.WithLabelValues(dest, window).Set(v)
		}
		for _, c := range cfg.Chains {
			usdcNet.WithLabelValues(c.Slug, window).Set(inbound[c.Slug] - outTotal[c.Slug])
		}
	}
}
