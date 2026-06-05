package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	installLogCapture() // first — captures stdout into the ring buffer for /logs?tail=N
	fmt.Println("=== EVM Swap Quoting Latency Monitor ===")
	fmt.Println("Measures p50/p99 round-trip latency for EVM swap aggregators on a rotating 5-pair basket.")
	fmt.Println("Press Ctrl+C to stop")
	fmt.Println()

	cfg, err := loadEnv()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Region:           %s\n", cfg.MonitorRegion)
	fmt.Printf("Mobula key set:   %v\n", cfg.MobulaAPIKey != "")
	fmt.Printf("1inch key set:    %v\n", cfg.OneInchAPIKey != "")
	fmt.Printf("0x key set:       %v\n", cfg.ZeroExAPIKey != "")
	fmt.Printf("Odos key set:     %v\n", cfg.OdosAPIKey != "")
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
