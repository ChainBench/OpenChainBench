package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// RelaySolver is the Relay solver EOA. Same address on every EVM chain
// via CREATE2; Mobula's wallet portfolio endpoint aggregates across all
// the chains it indexes for us, so the harness only needs one address.
const RelaySolver = "0xf70da97812CB96acDF810712Aa562db8dfA3dbEF"

func main() {
	installLogCapture()
	fmt.Println("=== Relay Revenue Monitor ===")
	fmt.Println("Polls Mobula /wallet/portfolio for the Relay solver EOA every N seconds")
	fmt.Println("and tracks the balance delta over 24h / 7d / 30d as a floor on captured margin.")
	fmt.Printf("Solver: %s\n\n", RelaySolver)

	cfg, err := loadEnv()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Mobula key set:  %v\n", cfg.MobulaAPIKey != "")
	fmt.Printf("Poll interval:   %ds\n", cfg.PollIntervalSec)
	fmt.Println()

	window := NewWindow()
	poller := NewPoller(cfg, window)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Println("Starting metrics server on :2112")
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("metrics server: %v\n", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		poller.Run(ctx)
	}()

	// Recompute the 24h / 7d / 30d delta gauges every minute and prune
	// snapshots older than 31 days. Separate from the poller so the
	// gauges stay fresh even when a poll is in flight.
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				now := time.Now()
				t24, s24 := window.Delta(now, 24*time.Hour)
				t7, s7 := window.Delta(now, 7*24*time.Hour)
				t30, s30 := window.Delta(now, 30*24*time.Hour)
				balanceDeltaUSD.WithLabelValues("total", "24h").Set(t24)
				balanceDeltaUSD.WithLabelValues("stables", "24h").Set(s24)
				balanceDeltaUSD.WithLabelValues("total", "7d").Set(t7)
				balanceDeltaUSD.WithLabelValues("stables", "7d").Set(s7)
				balanceDeltaUSD.WithLabelValues("total", "30d").Set(t30)
				balanceDeltaUSD.WithLabelValues("stables", "30d").Set(s30)
				window.Prune(now, 31*24*time.Hour)
				windowSnapshots.Set(float64(window.Count()))
			}
		}
	}()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan
	fmt.Println("\nShutting down...")
	cancel()
	wg.Wait()
	fmt.Println("Stopped")
}
