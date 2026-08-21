// dune-platform-volume -- Bench 201 (replaces Mobula lighthouse source)
//
// Queries Dune community datasets (dataset_*_daily)
// for cross-chain trading platform volume. Each dataset has columns:
// day, blockchain, volume_usd, fees_usd, txns, wallets.
// pump.fun uses dataset_pumpapp_sol_daily (Solana) + dataset_pumpfun_relay_daily (relay).
// fomo uses dataset_fomo_sol_daily (no blockchain column).
//
// Required env vars:
//   DUNE_API_KEY  - Dune Analytics API key
//
// Metrics on :2112/metrics:
//   dune_platform_volume_24h_usd{platform}
//   dune_platform_volume_health{platform}
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	fetchInterval   = 15 * time.Minute
	refreshInterval = 4 * time.Hour
)

func main() {
	fmt.Println("=== dune-platform-volume harness ===")
	fmt.Println("OpenChainBench Bench 201 -- Cross-chain trading platform volume via Dune community datasets.")

	apiKey := os.Getenv("DUNE_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "[fatal] DUNE_API_KEY not set")
		os.Exit(1)
	}

	queryID := os.Getenv("DUNE_QUERY_ID")
	client := newDuneClient(apiKey)

	if queryID == "" {
		fmt.Println("[init] DUNE_QUERY_ID not set, creating Dune query...")
		id, err := client.createQuery()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[fatal] failed to create Dune query: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[init] Dune query created: %s\n", id)
		fmt.Printf("[init] Set DUNE_QUERY_ID=%s and restart the harness.\n", id)
		os.Exit(0)
	}

	go func() {
		if err := startMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	runFetch(client, queryID)
	go func() {
		execID, err := client.execute(queryID)
		if err != nil {
			fmt.Printf("[refresh] execute failed: %v\n", err)
			return
		}
		pollUntilDone(client, queryID, execID)
	}()

	fetchTick := time.NewTicker(fetchInterval)
	refreshTick := time.NewTicker(refreshInterval)
	defer fetchTick.Stop()
	defer refreshTick.Stop()

	for {
		select {
		case <-sig:
			fmt.Println("[shutdown] received signal")
			return
		case <-fetchTick.C:
			runFetch(client, queryID)
		case <-refreshTick.C:
			execID, err := client.execute(queryID)
			if err != nil {
				fmt.Printf("[refresh] execute failed: %v\n", err)
				continue
			}
			go pollUntilDone(client, queryID, execID)
		}
	}
}

func runFetch(c *duneClient, queryID string) {
	rows, err := c.latestResult(queryID)
	if err != nil {
		fmt.Printf("[fetch] failed: %v\n", err)
		return
	}
	publishRows(rows)
	fmt.Printf("[fetch] updated %d platform(s)\n", len(rows))
}

func pollUntilDone(c *duneClient, queryID, execID string) {
	for range 60 {
		time.Sleep(30 * time.Second)
		state, err := c.executionState(execID)
		if err != nil {
			fmt.Printf("[poll] state check failed: %v\n", err)
			return
		}
		switch state {
		case "QUERY_STATE_COMPLETED":
			fmt.Printf("[poll] execution %s complete\n", execID)
			runFetch(c, queryID)
			return
		case "QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED":
			fmt.Printf("[poll] execution %s ended with state %s\n", execID, state)
			return
		}
	}
	fmt.Printf("[poll] execution %s timed out waiting\n", execID)
}
