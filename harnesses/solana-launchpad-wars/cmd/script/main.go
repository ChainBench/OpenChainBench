// solana-launchpad-wars -- Bench 200
//
// Polls the Mobula lighthouse endpoint every 15 minutes and exposes
// per-launchpad 24h volume, fees and trade counts as Prometheus gauges.
//
// Metrics on :2112/metrics:
//
//	solana_launchpad_volume_24h_usd{launchpad}
//	solana_launchpad_fees_24h_usd{launchpad}
//	solana_launchpad_trades_24h{launchpad}
//	solana_launchpad_health{launchpad}
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const pollInterval = 15 * time.Minute

func main() {
	fmt.Println("=== solana-launchpad-wars harness ===")
	fmt.Println("OpenChainBench Bench 200 -- Solana launchpad leaderboard via Mobula lighthouse.")

	apiKey := os.Getenv("MOBULA_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "[fatal] MOBULA_API_KEY not set")
		os.Exit(1)
	}

	client := newMobulaClient(apiKey)

	go func() {
		if err := startMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	runOnce(client)

	tick := time.NewTicker(pollInterval)
	defer tick.Stop()

	for {
		select {
		case <-sig:
			fmt.Println("[shutdown] received signal")
			return
		case <-tick.C:
			runOnce(client)
		}
	}
}

func runOnce(c *mobulaClient) {
	data, err := c.fetchLighthouse()
	if err != nil {
		fmt.Printf("[poll] lighthouse fetch failed: %v\n", err)
		return
	}
	publishLighthouse(data)
	fmt.Printf("[poll] updated: %d launchpads, %d platforms\n",
		len(data.ByLaunchpad), len(data.ByPlatform))
}
