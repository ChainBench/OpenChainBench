// solana-unique-traders -- Bench 207
//
// Fetches the Dune query result (unique daily traders per Solana platform)
// and exposes it as Prometheus gauges. Triggers a fresh Dune execution every
// hour; serves the latest cached result every 15 minutes in between.
//
// Required env vars:
//   DUNE_API_KEY     - Dune Analytics API key
//   DUNE_QUERY_ID    - ID of the saved Dune query (see queries/unique_traders.sql)
//                      If not set, the harness creates the query automatically and exits.
//
// Metrics on :2112/metrics:
//   solana_platform_unique_traders_24h{platform}
//   solana_platform_trader_health{platform}
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
	refreshInterval = 1 * time.Hour
)

func main() {
	fmt.Println("=== solana-unique-traders harness ===")
	fmt.Println("OpenChainBench Bench 207 -- Unique daily traders by Solana platform via Dune.")

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

	// On startup: fetch latest cached result immediately, then trigger a fresh execution.
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
	for range 30 {
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
