package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== WS Head Latency Monitor ===")
	fmt.Println("Bench № 081 — per-block WebSocket push lag across RPC providers, relative to the earliest arrival in the cohort.")
	fmt.Println()

	eps := endpoints()
	addr := listenAddr()
	fmt.Printf("Connections tracked: %d\n", len(eps))
	for _, ep := range eps {
		fmt.Printf("  %-12s %-9s %s\n", ep.Provider, ep.Chain, ep.URL)
	}
	fmt.Printf("Metrics server: %s/metrics\n\n", addr)

	go func() {
		if err := StartMetricsServer(addr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	StartEndpoints()
	startHealthSweeper()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
}
