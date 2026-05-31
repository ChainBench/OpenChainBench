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
// each tick quoting USDC -> a fresh tokenOut picked from the trending list.
// Rotating the tokenOut every tick defeats per-pair edge caches (Jupiter caches
// SOL↔USDC aggressively) and forces every provider to actually search a route,
// which is the metric this bench is supposed to compare.
func runScheduler(cfg *Config, stopChan <-chan struct{}) {
	providers := buildProviders(cfg)
	fmt.Printf("[SCHED] starting with %d providers, region=%s, tick=%s\n",
		len(providers), cfg.MonitorRegion, tickInterval)
	for _, p := range providers {
		fmt.Printf("[SCHED]   - %s\n", p.Slug())
	}

	// Trending fetcher needs an API key; without one, the bench cannot rotate
	// tokens and we exit early — the cold-path SOL↔USDC fallback was retired
	// when bench-029 v2 landed.
	if cfg.MobulaAPIKey == "" {
		fmt.Println("[SCHED] FATAL: MOBULA_API_KEY is required to fetch the trending token rotation; aborting")
		return
	}
	trending := NewTrendingFetcher(cfg.MobulaAPIKey)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go trending.Run(ctx)

	// Wait up to 15s for the first trending list to land. If it never does we
	// abort rather than emit nonsense.
	waitDeadline := time.Now().Add(15 * time.Second)
	for {
		if _, ok := trending.Pick(); ok {
			break
		}
		if time.Now().After(waitDeadline) {
			fmt.Println("[SCHED] FATAL: trending list never loaded; aborting (check MOBULA_API_KEY and network)")
			return
		}
		time.Sleep(500 * time.Millisecond)
	}

	// First tick fires immediately so we don't wait 60s for the first datapoint.
	runTick(providers, cfg.MonitorRegion, trending)

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stopChan:
			fmt.Println("[SCHED] stop signal received")
			return
		case <-ticker.C:
			runTick(providers, cfg.MonitorRegion, trending)
		}
	}
}

func runTick(providers []Provider, region string, trending *TrendingFetcher) {
	tokenOut, ok := trending.Pick()
	if !ok {
		fmt.Println("[SCHED] tick skipped: trending list empty (refresh has not landed yet)")
		return
	}
	fmt.Printf("[SCHED] tick: quoting USDC -> %s (%s)\n", tokenOut.Symbol, tokenOut.Mint)

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
