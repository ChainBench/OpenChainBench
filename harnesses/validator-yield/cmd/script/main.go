package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Port hardcoded :2112 per the OCB Railway convention. The shared
// Prometheus scrapes every harness at <svc>.railway.internal:2112; if
// we let Railway's $PORT inject we'd silently lose scrape coverage.
// Same pattern as gas-estimation / l2-block-time.

func main() {
	fmt.Println("=== Validator Economics Harness ===")
	fmt.Println("OpenChainBench bench #026 — net yield = gross APR + MEV − downtime")
	fmt.Println("Scope v1: Solana + Hyperliquid (Ethereum deferred to v2)")
	fmt.Println()

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()
	fmt.Println("Metrics server: :2112/metrics, :2112/health")
	fmt.Println()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client := &http.Client{Timeout: httpTimeout}

	// Per-chain scrape goroutines. They tick on the same interval but
	// hit independent upstreams so there's no rate-limit interaction.
	go runChainScraper(ctx, client, "solana", scrapeSolana)
	go runChainScraper(ctx, client, "hyperliquid", scrapeHyperliquid)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}

// runChainScraper invokes fn immediately, then every scrapeInterval.
// Each fn is expected to wrap its own HTTP calls in a context derived
// from the caller's so cancel propagates cleanly on shutdown.
func runChainScraper(ctx context.Context, client *http.Client, label string, fn func(context.Context, *http.Client)) {
	tick := func() {
		scrapeCtx, cancel := context.WithTimeout(ctx, httpTimeout*2)
		defer cancel()
		fn(scrapeCtx, client)
	}
	tick()
	t := time.NewTicker(scrapeInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}
