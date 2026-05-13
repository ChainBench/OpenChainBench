package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

func main() {
	installLogCapture() // must be first — captures all subsequent stdout into ring buffer for /logs
	fmt.Println("=== Aggregator Indexation Lag Monitor ===")
	fmt.Println("Measuring real-time indexation lag (head lag) for blockchain data APIs")
	fmt.Println("Press Ctrl+C to stop")
	fmt.Println()

	config, err := loadEnv()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	// Use session cookie from environment (scraping requires GUI, doesn't work on Railway)
	if config.DefinedSessionCookie == "" {
		fmt.Println("Warning: DEFINED_SESSION_COOKIE not set in environment")
		fmt.Println("Codex REST and WebSocket monitors will not work")
	} else {
		fmt.Printf("Using DEFINED_SESSION_COOKIE from environment (length: %d)\n", len(config.DefinedSessionCookie))
	}

	fmt.Println("Metrics will be exposed on :2112/metrics for Prometheus")
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

	// Mobula Pulse V2 feeder — discovers fresh tokens and pushes them
	// onto the metadata-coverage queue. No pulse-specific metrics emitted.
	wg.Add(1)
	go func() {
		defer wg.Done()
		runMobulaPulseMonitor(config, stopChan)
	}()

	// Metadata coverage monitor — the only data producer. Consumes the
	// queue, queries each aggregator's metadata endpoint, records field
	// coverage (logo, description, twitter, website).
	wg.Add(1)
	go func() {
		defer wg.Done()
		runMetadataCoverageMonitor(config, stopChan)
	}()

	<-sigChan
	fmt.Println("\n\nShutting down monitors...")
	close(stopChan)

	wg.Wait()
	fmt.Println("All monitors stopped")
}
