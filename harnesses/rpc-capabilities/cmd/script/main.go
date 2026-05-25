package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// Metrics server listens on :2112 — the OCB convention for every
// harness scraped by the shared Prometheus at
// <service>.railway.internal:2112. We deliberately ignore Railway's
// $PORT injection so a Railway-injected public port doesn't move the
// listener away from the address Prometheus expects. Same fix as
// l2-block-time (see mobula-api commit 833026a719).

func main() {
	fmt.Println("=== RPC Capabilities Harness ===")
	fmt.Println("OpenChainBench - public RPC latency, reliability, and archive depth.")
	fmt.Println()

	for _, c := range chains() {
		fmt.Printf("[%s] %d providers\n", c.Slug, len(c.Providers))
		for _, p := range c.Providers {
			fmt.Printf("  - %-12s %s\n", p.Slug, p.URL)
		}
	}
	fmt.Println()
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

	StartProbeLoop(ctx)
	StartArchiveLoop(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}
