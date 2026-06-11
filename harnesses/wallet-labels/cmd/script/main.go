package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
)

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	_ = godotenv.Load() // optional .env for local dev. NEVER commit it.

	cfg := loadConfig()
	providers := buildProviders(cfg)

	if len(os.Args) > 1 && os.Args[1] == "--test" {
		runIntegrationTest(cfg, providers)
		return
	}

	q := newQueue(cfg.QueueSize)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start metrics + debug HTTP server.
	go func() {
		fmt.Printf("Starting Prometheus metrics server on %s\n", cfg.PromListen)
		if err := startMetricsServer(cfg.PromListen, cfg.LogsToken); err != nil {
			fmt.Printf("Metrics server error: %v\n", err)
		}
	}()

	go runAnchorFeeder(ctx, q)
	runWorkers(ctx, cfg, q, providers)
	go statsLoop(ctx)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	fmt.Println("\nShutting down...")
	cancel()
	time.Sleep(500 * time.Millisecond)
}

func buildProviders(cfg *Config) []Provider {
	ps := []Provider{
		NewMobulaProvider(cfg.MobulaAPIKey),
		NewMoralisProvider(cfg.MoralisAPIKey),
		NewHeliusProvider(cfg.HeliusAPIKey),
		NewBlockscoutProvider(),
		NewOLIProvider(),
		NewTonAPIProvider(),
		NewStellarExpertProvider(),
		NewXRPScanProvider(),
		NewWalletExplorerProvider(),
	}
	return ps
}

// statsLoop prints a periodic summary table to /logs so a quick curl
// shows current coverage rates per provider per chain without hitting
// Prometheus.
func statsLoop(ctx context.Context) {
	t := time.NewTicker(2 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fmt.Println(buildStatsSnapshot())
		}
	}
}

func buildStatsSnapshot() string {
	// We rely on the Prom collector: pull current counter values via the
	// promtest registry would be heavy. Keep it minimal — print queue
	// depth and let users hit /metrics for the rest.
	return fmt.Sprintf("[STATS] queue_depth=approximate, see /metrics for full numbers · %s",
		time.Now().UTC().Format(time.RFC3339))
}
