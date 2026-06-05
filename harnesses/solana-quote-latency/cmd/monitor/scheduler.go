package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const (
	tickInterval = 60 * time.Second
	probeTimeout = 10 * time.Second
)

// buildProviders returns the enabled provider list given the resolved config.
// Public providers (Jupiter, OpenOcean, Raydium) are always on; gated providers
// (Mobula, DFlow) require their API key to be set.
func buildProviders(cfg *Config) []Provider {
	providers := []Provider{
		NewJupiterProvider(cfg.MonitorRegion, cfg.JupiterAPIKey),
		NewOpenOceanProvider(cfg.MonitorRegion),
		NewRaydiumProvider(cfg.MonitorRegion),
	}
	if cfg.MobulaAPIKey != "" {
		providers = append(providers, NewMobulaProvider(cfg.MonitorRegion, cfg.MobulaAPIKey))
	}
	if cfg.DFlowAPIKey != "" {
		providers = append(providers, NewDFlowProvider(cfg.MonitorRegion, cfg.DFlowAPIKey))
	}
	return providers
}

// runScheduler ticks every 60s and fans out one Probe per provider in parallel,
// each tick quoting USDC -> a fresh tokenOut picked from the Pulse-fed
// trending pool. Token rotation defeats per-pair edge caching (Jupiter caches
// SOL↔USDC aggressively) and forces every provider to actually search a route.
//
// Rotation source priority:
//   1. Pulse V2 WS bonded view (preferred — refreshed millisecond-by-millisecond
//      with the tokens actually trending right now on Solana).
//   2. REST market-query snapshot (fallback — kept warm on a 10-min cron so the
//      bench survives a Pulse outage).
//
// Pick() inside TrendingFetcher does the priority selection; scheduler never
// has to branch on which source is currently live.
func runScheduler(cfg *Config, stopChan <-chan struct{}) {
	providers := buildProviders(cfg)
	fmt.Printf("[SCHED] starting with %d providers, region=%s, tick=%s\n",
		len(providers), cfg.MonitorRegion, tickInterval)
	for _, p := range providers {
		fmt.Printf("[SCHED]   - %s\n", p.Slug())
	}

	if cfg.MobulaAPIKey == "" {
		fmt.Println("[SCHED] FATAL: MOBULA_API_KEY is required to feed the trending rotation; aborting")
		return
	}

	trending := NewTrendingFetcher(cfg.MobulaAPIKey)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Pulse WS — primary rotation source.
	pulse := NewPulseSubscriber(cfg.MobulaAPIKey, trending)
	go pulse.Run(ctx)

	// REST snapshot — fallback rotation source.
	go trending.RunREST(ctx)

	// Wait up to 30s for at least one rotation entry to land. Either source
	// arriving first is fine — Pulse usually wins (sub-second once dialed) but
	// REST will fill in within ~1s of the first /market/query response.
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, ok := trending.Pick(); ok {
			break
		}
		if time.Now().After(deadline) {
			fmt.Println("[SCHED] FATAL: rotation pool never loaded (Pulse WS + REST both down for 30s); aborting")
			return
		}
		time.Sleep(500 * time.Millisecond)
	}

	// First tick fires immediately so we don't wait 60s for the first datapoint.
	runTick(providers, cfg.MonitorRegion, trending, pulse)

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stopChan:
			fmt.Println("[SCHED] stop signal received")
			return
		case <-ticker.C:
			runTick(providers, cfg.MonitorRegion, trending, pulse)
		}
	}
}

func runTick(providers []Provider, region string, trending *TrendingFetcher, pulse *PulseSubscriber) {
	tokenOut, ok := trending.Pick()
	if !ok {
		fmt.Println("[SCHED] tick skipped: rotation pool empty")
		return
	}
	src := "REST"
	if pulse.IsConnected() {
		src = "PULSE"
	}
	pulseLive, restCount := trending.Stats()
	fmt.Printf("[SCHED] tick: USDC -> %s (%s) — src=%s pool: pulse=%d rest=%d\n",
		tokenOut.Symbol, tokenOut.Mint, src, pulseLive, restCount)

	var wg sync.WaitGroup
	for _, p := range providers {
		wg.Add(1)
		go func(p Provider) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
			defer cancel()

			latencyMs, ok, err := p.Probe(ctx, tokenOut)
			RecordSuccess(p.Slug(), region, ok)
			if !ok {
				fmt.Printf("[SCHED][%s] FAIL (%s): %v\n", p.Slug(), tokenOut.Symbol, err)
				return
			}
			RecordLatency(p.Slug(), region, latencyMs)
			fmt.Printf("[SCHED][%s] ok %s latency=%dms\n", p.Slug(), tokenOut.Symbol, latencyMs)
		}(p)
	}
	wg.Wait()
}
