// perp-cohort-stats is a Prom-exporter harness that publishes per-venue
// cohort gauges for the OCB perp benches and product pages.
//
// Architecture is multi-source with a priority router (see adapter.go).
// Each metric has an ordered list of acceptable sources; the first that
// returns non-nil wins. The next source in the list is still consulted
// for cross-check: divergences > 10 percent bump a counter but never
// gate publication.
//
// HTTP server is fixed at :2112 per the OCB Railway harness convention.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func main() {
	installLogCapture()
	fmt.Println("=== perp-cohort-stats harness ===")
	fmt.Println("Multi-source per-venue perp cohort stats (HL native, Lighter native, DefiLlama, Mobula funding).")
	fmt.Println("Exposes /metrics, /health, /logs on :2112.")

	cfg := loadConfig()
	router := NewRouter(cfg, time.Now)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Println("Starting Prometheus metrics server on :2112")
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("Metrics server error: %v\n", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runSweepLoop(cfg, router, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runSweepLoop(cfg *Config, router *Router, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.TickInterval)
	defer tick.Stop()

	// Run once immediately so /metrics has values before the first tick.
	router.Sweep()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			router.Sweep()
		}
	}
}
