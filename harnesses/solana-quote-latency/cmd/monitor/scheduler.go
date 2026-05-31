package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const (
	tickInterval   = 60 * time.Second
	probeTimeout   = 10 * time.Second
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

// runScheduler ticks every 60s and fans out one Probe per provider in parallel.
// Records the histogram only on success. Counters / gauge are updated by both
// the provider (auth/throttle/other) and the scheduler (success gauge).
func runScheduler(cfg *Config, stopChan <-chan struct{}) {
	providers := buildProviders(cfg)
	fmt.Printf("[SCHED] starting with %d providers, region=%s, tick=%s\n",
		len(providers), cfg.MonitorRegion, tickInterval)
	for _, p := range providers {
		fmt.Printf("[SCHED]   - %s\n", p.Slug())
	}

	// First tick fires immediately so we don't wait 60s for the first datapoint.
	runTick(providers, cfg.MonitorRegion)

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stopChan:
			fmt.Println("[SCHED] stop signal received")
			return
		case <-ticker.C:
			runTick(providers, cfg.MonitorRegion)
		}
	}
}

func runTick(providers []Provider, region string) {
	var wg sync.WaitGroup
	for _, p := range providers {
		wg.Add(1)
		go func(p Provider) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
			defer cancel()

			latencyMs, ok, err := p.Probe(ctx)
			RecordSuccess(p.Slug(), region, ok)
			if !ok {
				fmt.Printf("[SCHED][%s] FAIL: %v\n", p.Slug(), err)
				return
			}
			RecordLatency(p.Slug(), region, latencyMs)
			fmt.Printf("[SCHED][%s] ok latency=%dms\n", p.Slug(), latencyMs)
		}(p)
	}
	wg.Wait()
}
