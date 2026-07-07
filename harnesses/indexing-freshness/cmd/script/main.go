package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// indexing-freshness — bench №070.
//
// One probe event per interval: grab a fresh organic native transfer
// from the newest block (T0 = our observation of the block), then poll
// every cohort wallet API on a front-loaded schedule until each one
// returns the tx (lag = poll time − T0) or 120s passes (missed).

func main() {
	fmt.Println("=== Indexing Freshness Harness ===")
	fmt.Println("OpenChainBench — organic tx → wallet-API visibility lag.")
	if rpcHTTP() == "" {
		fmt.Println("[fatal] INDEXING_RPC_HTTP not set")
		os.Exit(1)
	}
	active := activeProviders()
	if len(active) == 0 {
		fmt.Println("[fatal] no INDEXING_KEY_* env vars set")
		os.Exit(1)
	}
	fmt.Printf("Chain: %s | event interval: %s | poll cap: %ds\n", chainSlug, eventInterval(), pollSchedule[len(pollSchedule)-1])
	for _, p := range active {
		fmt.Printf("  - %-10s everyN=%d budget=%d calls/mo\n", p.Slug, p.EveryN, p.Budget)
	}

	addr := ":2112"
	if v := strings.TrimSpace(os.Getenv("METRICS_ADDR")); v != "" {
		addr = v
	}
	fmt.Printf("Metrics server: %s/metrics\n\n", addr)
	go func() {
		if err := StartMetricsServer(addr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runEvents(ctx, active)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] %v\n", s)
	cancel()
}

func runEvents(ctx context.Context, active []Provider) {
	t := time.NewTicker(eventInterval())
	defer t.Stop()
	var lastSeen uint64
	eventN := 0
	for {
		eventN++
		_, bn, tx := waitFreshBlock(lastSeen)
		lastSeen = bn
		t0 := time.Now()
		fmt.Printf("[event %d] block=%d tx=%s wallet=%s\n", eventN, bn, tx.Hash[:14]+"…", tx.From[:10]+"…")

		var wg sync.WaitGroup
		for _, p := range active {
			if eventN%p.EveryN != 0 {
				continue
			}
			if !quota.allow(p) {
				probeTotal.WithLabelValues(p.Slug, chainSlug, "quota_paused").Inc()
				fmt.Printf("  %-10s quota guard tripped — paused until month rollover\n", p.Slug)
				continue
			}
			wg.Add(1)
			go func(p Provider) {
				defer wg.Done()
				raceProvider(ctx, p, tx.From, tx.Hash, t0)
			}(p)
		}
		wg.Wait()

		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func raceProvider(ctx context.Context, p Provider, wallet, txHash string, t0 time.Time) {
	var lastErr error
	for _, after := range pollSchedule {
		wait := time.Until(t0.Add(time.Duration(after) * time.Second))
		if wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
		found, err := checkProvider(p.Slug, wallet, txHash)
		if err != nil {
			lastErr = err
			continue
		}
		if found {
			lag := time.Since(t0).Seconds()
			freshnessSeconds.WithLabelValues(p.Slug, chainSlug).Set(lag)
			freshnessHist.WithLabelValues(p.Slug, chainSlug).Observe(lag)
			probeTotal.WithLabelValues(p.Slug, chainSlug, "found").Inc()
			fmt.Printf("  %-10s found in %.1fs\n", p.Slug, lag)
			return
		}
	}
	if lastErr != nil {
		probeTotal.WithLabelValues(p.Slug, chainSlug, "api_error").Inc()
		fmt.Printf("  %-10s api_error: %s\n", p.Slug, sanitize(lastErr))
		return
	}
	probeTotal.WithLabelValues(p.Slug, chainSlug, "missed").Inc()
	fmt.Printf("  %-10s MISSED (not indexed within %ds)\n", p.Slug, pollSchedule[len(pollSchedule)-1])
}
