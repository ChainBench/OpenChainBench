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
	llama := newDefillamaClient()

	startSolPriceRefresher(solPriceRefresh)

	go func() {
		if err := startMetricsServer(":2112"); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	// Sync Dune query SQL to the embedded feesSQL constant, then trigger a fresh execution.
	// This ensures new SQL columns (e.g. fee_paying_volume_usd_24h) are picked up automatically.
	if err := dune.updateQuery(queryID); err != nil {
		fmt.Printf("[init] Dune query update failed (continuing with cached SQL): %v\n", err)
	} else {
		fmt.Println("[init] Dune query SQL synced")
	}

	// On startup: fetch cached Dune result + current lighthouse data immediately,
	// then trigger a fresh Dune execution in the background.
	runPoll(dune, lighthouse, llama, queryID)
	go func() {
		execID, err := dune.execute(queryID)
		if err != nil {
			fmt.Printf("[refresh] execute failed: %v\n", err)
			return
		}
		pollUntilDone(dune, lighthouse, llama, queryID, execID)
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
			runPoll(dune, lighthouse, llama, queryID)
		case <-refreshTick.C:
			execID, err := dune.execute(queryID)
			if err != nil {
				fmt.Printf("[refresh] execute failed: %v\n", err)
				continue
			}
			go pollUntilDone(dune, lighthouse, llama, queryID, execID)
		}
	}
}

func runPoll(dune *duneClient, lh *lighthouseClient, llama *defillamaClient, queryID string) {
	rows, err := dune.latestResult(queryID)
	if err != nil {
		if isNoExecutionError(err) {
			// After a SQL update, Dune creates a new version with no execution yet.
			// The background goroutine will execute and call runPoll when done.
			fmt.Printf("[fetch] dune: no execution for current query version, waiting for background refresh\n")
		} else {
			fmt.Printf("[fetch] dune failed: %v\n", err)
			platformHealth.Set(0)
		}
		return
	}

	volumes, err := lh.fetchVolumes()
	if err != nil {
		fmt.Printf("[fetch] lighthouse failed: %v\n", err)
		platformHealth.Set(0)
		return
	}

	solUSD := getSolPrice()

	// Aggregate rows per platform (Dune may return multiple rows).
	type totals struct {
		feesUSD            float64
		feePayingVolumeUSD float64
	}
	byPlatform := make(map[string]*totals)
	var latestBlockTime string
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
		t.feePayingVolumeUSD += r.FeePayingVolumeUSD24h
		if r.DataFreshness > latestBlockTime {
			latestBlockTime = r.DataFreshness
		}
	}
	if latestBlockTime != "" {
		s := latestBlockTime
		if len(s) > 19 {
			s = s[:19]
		}
		for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
			if ts, err := time.Parse(layout, s); err == nil {
				duneDataFreshness.Set(float64(ts.Unix()))
				break
			}
		}
	}

	// Fomo fees: on-chain USDC sweeps + off-chain relay fees only accessible
	// via DeFiLlama (private Dune table dune.tryfomo.fomo_relay_fees).
	fomoFees, err := llama.fetchFomoFees()
	if err != nil {
		fmt.Printf("[fetch] fomo/defillama failed: %v\n", err)
	} else if fomoFees > 0 {
		byPlatform["fomo"] = &totals{feesUSD: fomoFees}
	}

	for platform, t := range byPlatform {
		mobulaVol := volumes[platform]
		feesUSD24h.WithLabelValues(platform).Set(t.feesUSD)
		volumeUSD24h.WithLabelValues(platform).Set(mobulaVol)
		feePayingVolumeUSD24h.WithLabelValues(platform).Set(t.feePayingVolumeUSD)

		rate := 0.0
		if mobulaVol > 0 {
			rate = t.feesUSD / mobulaVol * 100
		}
		feeRatePct.WithLabelValues(platform).Set(rate)

		if t.feePayingVolumeUSD > 0 {
			feePayingRatePct.WithLabelValues(platform).Set(t.feesUSD / t.feePayingVolumeUSD * 100)
			if mobulaVol > 0 {
				coveragePct.WithLabelValues(platform).Set(t.feePayingVolumeUSD / mobulaVol * 100)
			}
		}
	}

	lastPollTime.SetToCurrentTime()
	platformHealth.Set(1)
	fmt.Printf("[fetch] updated %d platform(s), sol=$%.2f\n", len(byPlatform), solUSD)
}

func pollUntilDone(dune *duneClient, lh *lighthouseClient, llama *defillamaClient, queryID, execID string) {
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
			runPoll(dune, lh, llama, queryID)
			return
		case "QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED":
			fmt.Printf("[poll] execution %s ended with state %s\n", execID, state)
			return
		}
	}
	fmt.Printf("[poll] execution %s timed out waiting\n", execID)
}
