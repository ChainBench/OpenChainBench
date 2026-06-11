package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== L2 Block Time Monitor ===")
	fmt.Println("Bench № 009 — measures live wall-clock interval between newHeads events on each L2 sequencer.")
	fmt.Println()

	chains := l2Chains()
	addr := listenAddr()
	fmt.Printf("Chains tracked: %d\n", len(chains))
	for _, c := range chains {
		fmt.Printf("  %-10s %s\n", c.Slug, c.URL)
	}
	fmt.Printf("Metrics server: %s/metrics\n\n", addr)

	go func() {
		if err := StartMetricsServer(addr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	StartSequencerWS()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
}
