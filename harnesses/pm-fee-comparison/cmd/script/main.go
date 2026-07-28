package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	fmt.Println("=== pm-fee-comparison harness ===")
	fmt.Println("Effective taker fees in basis points per venue. Static for most venues; live spread for Limitless.")
	fmt.Println("Exposes /metrics on :2112.")

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[pm-fee-comparison] metrics server error: %v\n", err)
			os.Exit(1)
		}
	}()

	// Set static fees immediately at startup.
	setStaticFees()
	// Fetch Limitless live spread at startup then every hour.
	fetchLimitlessFee()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-sigChan:
			fmt.Println("[pm-fee-comparison] shutting down")
			return
		case <-ticker.C:
			fetchLimitlessFee()
		}
	}
}
