// memecoin-platforms -- Bench 203
//
// Computes per-platform take rates for Solana memecoin trading bots by combining:
//   - Dune Analytics: fee wallet inflows (USDC + WSOL + native SOL) -> fees_usd_24h
//   - Mobula lighthouse: platform trading volume -> volume_usd_24h
//   - take_rate = fees_usd_24h / volume_usd_24h * 100
//
// Required env vars:
//
//	DUNE_API_KEY      - Dune Analytics API key
//	DUNE_QUERY_ID     - Dune query ID (leave empty on first run; harness prints it and exits)
//	MOBULA_API_KEY    - Mobula API key
//
// Metrics on :2112/metrics:
//
//	memecoin_platform_fee_rate_pct{platform}
//	memecoin_platform_fees_usd_24h{platform}
//	memecoin_platform_volume_usd_24h{platform}
//	memecoin_platform_health
//	memecoin_last_poll_timestamp_seconds
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
	refreshInterval = 6 * time.Hour
	solPriceRefresh = 5 * time.Minute
)

func main() {
	fmt.Println("=== memecoin-platforms harness ===")
	fmt.Println("OpenChainBench Bench 203 -- Memecoin platform fee rates via Dune + Mobula lighthouse.")

	duneKey := os.Getenv("DUNE_API_KEY")
	if duneKey == "" {
		fmt.Fprintln(os.Stderr, "[fatal] DUNE_API_KEY not set")
		os.Exit(1)
	}
	mobulaKey := os.Getenv("MOBULA_API_KEY")
	if mobulaKey == "" {
		fmt.Fprintln(os.Stderr, "[fatal] MOBULA_API_KEY not set")
		os.Exit(1)
	}

	queryID := os.Getenv("DUNE_QUERY_ID")
	dune := newDuneClient(duneKey)

	if queryID == "" {
		fmt.Println("[init] DUNE_QUERY_ID not set, creating Dune query...")
		id, err := dune.createQuery()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[fatal] failed to create Dune query: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[init] Dune query created: %s\n", id)
		fmt.Printf("[init] Set DUNE_QUERY_ID=%s and restart the harness.\n", id)
		os.Exit(0)
	}

	lighthouse := newLighthouseClient(mobulaKey)

	startSolPriceRefresher(solPriceRefresh)

	go func() {
		if err := startMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	// On startup: fetch cached Dune result + current lighthouse data immediately,
	// then trigger a fresh Dune execution in the background.
	runPoll(dune, lighthouse, queryID)
	go func() {
		execID, err := dune.execute(queryID)
		if err != nil {
			fmt.Printf("[refresh] execute failed: %v\n", err)
			return
		}
		pollUntilDone(dune, lighthouse, queryID, execID)
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
			runPoll(dune, lighthouse, queryID)
		case <-refreshTick.C:
			execID, err := dune.execute(queryID)
			if err != nil {
				fmt.Printf("[refresh] execute failed: %v\n", err)
				continue
			}
			go pollUntilDone(dune, lighthouse, queryID, execID)
		}
	}
}

func runPoll(dune *duneClient, lh *lighthouseClient, queryID string) {
	rows, err := dune.latestResult(queryID)
	if err != nil {
		fmt.Printf("[fetch] dune failed: %v\n", err)
		platformHealth.Set(0)
		return
	}

	volumes, err := lh.fetchVolumes()
	if err != nil {
		fmt.Printf("[fetch] lighthouse failed: %v\n", err)
		platformHealth.Set(0)
		return
	}

	solUSD := getSolPrice()

	// Aggregate rows per platform (Dune may return multiple rows for pump-fun).
	type totals struct {
		feesUSD float64
	}
	byPlatform := make(map[string]*totals)
	for _, r := range rows {
		if r.Platform == "" {
			continue
		}
		t, ok := byPlatform[r.Platform]
		if !ok {
			t = &totals{}
			byPlatform[r.Platform] = t
		}
		t.feesUSD += r.USDCFees24h + r.WSOLFees24h*solUSD + r.SOLFees24h*solUSD
	}

	for platform, t := range byPlatform {
		vol := volumes[platform]
		feesUSD24h.WithLabelValues(platform).Set(t.feesUSD)
		volumeUSD24h.WithLabelValues(platform).Set(vol)
		rate := 0.0
		if vol > 0 {
			rate = t.feesUSD / vol * 100
		}
		feeRatePct.WithLabelValues(platform).Set(rate)
	}

	lastPollTime.SetToCurrentTime()
	platformHealth.Set(1)
	fmt.Printf("[fetch] updated %d platform(s), sol=$%.2f\n", len(byPlatform), solUSD)
}

func pollUntilDone(dune *duneClient, lh *lighthouseClient, queryID, execID string) {
	for range 30 {
		time.Sleep(30 * time.Second)
		state, err := dune.executionState(execID)
		if err != nil {
			fmt.Printf("[poll] state check failed: %v\n", err)
			return
		}
		switch state {
		case "QUERY_STATE_COMPLETED":
			fmt.Printf("[poll] execution %s complete\n", execID)
			runPoll(dune, lh, queryID)
			return
		case "QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED":
			fmt.Printf("[poll] execution %s ended with state %s\n", execID, state)
			return
		}
	}
	fmt.Printf("[poll] execution %s timed out waiting\n", execID)
}
