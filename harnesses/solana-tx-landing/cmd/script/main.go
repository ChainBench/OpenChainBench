package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// Metrics server listens on :2112 — OCB convention. Same fix as
// l2-block-time / gas-estimation / rpc-capabilities — ignore Railway
// $PORT injection so Prometheus can scrape on the expected port.

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Solana TX Landing Harness ===")
	fmt.Println("OpenChainBench — observational market share + active landing latency.")
	fmt.Println()

	wsURL := envDefault("SOLANA_WS_URL", defaultSolanaWS)
	fmt.Printf("WebSocket: %s\n", wsURL)
	fmt.Println()
	services := walletsByService()
	total := 0
	for svc, ws := range services {
		fmt.Printf("  [%s] %d tip wallets\n", svc, len(ws))
		total += len(ws)
	}
	fmt.Printf("Total: %d wallets across %d services\n", total, len(services))
	fmt.Println()
	fmt.Println("Metrics server: :2112/metrics")
	fmt.Println()

	go func() {
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialise all service health to 0; subscriber flips to 1 on
	// successful subscription ack.
	for svc := range services {
		solanaLandingSubHealth.WithLabelValues(string(svc)).Set(0)
	}

	// Observational subscriber (always on).
	go runSubscriber(ctx, wsURL)

	// Active prober (opt-in: requires SOLANA_PROBE_KEYPAIR_BASE58).
	// Methodology: docs/methodology/solana-tx-landing-active.md
	go runProber(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	s := <-sig
	fmt.Printf("\n[shutdown] received %v\n", s)
	cancel()
}

func envDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
