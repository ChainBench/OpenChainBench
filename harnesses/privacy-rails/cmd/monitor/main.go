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
	fmt.Println("=== Privacy Rails Monitor ===")
	fmt.Println("Cost and time of going into a privacy asset and back, and which rails can pay a shielded address.")
	fmt.Println("Quote-only: no key, no wallet, nothing here can sign or send.")
	fmt.Println()

	cfg, err := loadEnv()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
	initMetrics()

	fmt.Printf("Region:            %s\n", cfg.MonitorRegion)
	fmt.Printf("Tick:              %s\n", cfg.TickInterval)
	fmt.Printf("Maya:              %s\n", cfg.MayaBase)
	fmt.Printf("NEAR 1Click:       %s\n", cfg.OneClickBase)
	fmt.Printf("XMR maker list:    %s\n", cfg.XmrListURL)

	// The delivery probe is the one measurement that can lie convincingly,
	// so its inputs are checked before anything runs and the verdict is
	// printed at boot rather than discovered in a dashboard.
	if err := VerifyDestinations(cfg); err != nil {
		fmt.Printf("Destinations:      INVALID, delivery probe disabled: %v\n", err)
	} else {
		fmt.Printf("Destinations:      transparent and shielded both checksum-verified\n")
	}
	fmt.Printf("Metrics on %s/metrics, logs on %s/logs (LOGS_TOKEN gated)\n", cfg.MetricsAddr, cfg.MetricsAddr)
	fmt.Println()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stopChan := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Printf("Starting Prometheus metrics server on %s\n", cfg.MetricsAddr)
		if err := StartMetricsServer(cfg.MetricsAddr); err != nil {
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
	fmt.Println("Stopped")
}
