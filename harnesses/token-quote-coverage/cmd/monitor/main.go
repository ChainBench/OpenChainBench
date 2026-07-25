package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	installLogCapture()
	fmt.Println("=== Token Quote Coverage Monitor ===")
	fmt.Println("Probes swap providers hourly against recently-boosted tokens from Dexscreener.")
	fmt.Println("Emits token_quote_coverage_success_total and token_quote_coverage_attempts_total.")
	fmt.Println()

	cfg, err := loadEnv()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Region:           %s\n", cfg.MonitorRegion)
	fmt.Printf("Mobula key set:   %v\n", cfg.MobulaAPIKey != "")
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
	fmt.Println("\nShutting down...")
	close(stopChan)
	wg.Wait()
	fmt.Println("Stopped")
}
