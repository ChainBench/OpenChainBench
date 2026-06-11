package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Solana Quote Latency Monitor (v2 — rotating long-tail tokens) ===")
	fmt.Println("Measuring USDC -> <rotating long-tail token> quote latency every 60s")
	fmt.Println("Token rotation defeats per-pair CDN caches; we measure routing search.")
	fmt.Println("Press Ctrl+C to stop")
	fmt.Println()

	cfg, err := loadEnv()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Region: %s\n", cfg.MonitorRegion)
	fmt.Printf("Mobula key set: %v\n", cfg.MobulaAPIKey != "")
	fmt.Printf("DFlow  key set: %v\n", cfg.DFlowAPIKey != "")
	fmt.Printf("Jupiter key set: %v (public lite endpoint works without it)\n", cfg.JupiterAPIKey != "")
	fmt.Println("Metrics on :2112/metrics, logs on :2112/logs (LOGS_TOKEN gated)")
	fmt.Println()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stopChan := make(chan struct{})

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
		runScheduler(cfg, stopChan)
	}()

	<-sigChan
	fmt.Println("\n\nShutting down...")
	close(stopChan)

	wg.Wait()
	fmt.Println("All monitors stopped")
}
