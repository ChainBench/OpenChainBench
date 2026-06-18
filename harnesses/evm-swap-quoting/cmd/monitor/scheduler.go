package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const (
	tickInterval = 60 * time.Second
	probeTimeout = 12 * time.Second
)

// buildProviders returns the enabled provider list. Mobula requires its key
// (already enforced in loadEnv). KyberSwap, Bebop, LI.FI, OpenOcean, CoW
// and Enso are always on (no auth required, but Enso benefits from
// ENSO_API_KEY which widens the otherwise tight anonymous 1rps bucket).
// Odos requires its free-tier API key — anonymous traffic gets rate-
// limited too aggressively for sustained probes.
//
// 0x was previously in the list, gated by ZEROX_API_KEY. Their team
// suspended our account because a benchmark issues quote requests
// without ever submitting fills — that ratio is their TOS-defined
// abuse signal and re-enabling requires a custom plan negotiation.
// Until/unless that contract exists, calling 0x just burns ticks on
// guaranteed auth errors that bloat the error counters; safer to
// drop the provider entirely.
func buildProviders(cfg *Config) []Provider {
	providers := []Provider{
		NewMobulaProvider(cfg.MonitorRegion, cfg.MobulaAPIKey),
		NewKyberSwapProvider(cfg.MonitorRegion),
		NewBebopProvider(cfg.MonitorRegion),
		NewLiFiProvider(cfg.MonitorRegion),
		NewOpenOceanProvider(cfg.MonitorRegion),
		NewCoWProvider(cfg.MonitorRegion),
		NewEnsoProvider(cfg.MonitorRegion, cfg.EnsoAPIKey),
	}
	if cfg.OdosAPIKey != "" {
		providers = append(providers, NewOdosProvider(cfg.MonitorRegion, cfg.OdosAPIKey))
	}
	return providers
}

// runScheduler ticks every 60s and rotates through the test basket
// (one pair per tick, round-robin). On each tick we fan out one Probe per
// (provider, pair) combo in parallel. Providers that don't Supports() the
// pair's chain are skipped silently.
//
// At basket size = 5 and tick = 60s, each (provider, chain, pair) sees a
// quote every 5 minutes = 288 samples per 24h, which is enough to land the
// p99 bucket reliably.
func runScheduler(cfg *Config, stopChan <-chan struct{}) {
	providers := buildProviders(cfg)
	fmt.Printf("[SCHED] starting with %d providers, region=%s, tick=%s\n",
		len(providers), cfg.MonitorRegion, tickInterval)
	for _, p := range providers {
		fmt.Printf("[SCHED]   - %s\n", p.Slug())
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tick := time.NewTicker(tickInterval)
	defer tick.Stop()

	idx := 0
	// First probe fires immediately so the first 60s of metrics isn't empty.
	doTick(ctx, providers, Basket[idx], cfg.MonitorRegion)
	idx = (idx + 1) % len(Basket)

	for {
		select {
		case <-stopChan:
			return
		case <-tick.C:
			doTick(ctx, providers, Basket[idx], cfg.MonitorRegion)
			idx = (idx + 1) % len(Basket)
		}
	}
}

// doTick runs every supporting provider against the picked pair in parallel.
// Per-probe deadline keeps a single slow provider from holding the whole
// tick — the scheduler still moves on after probeTimeout.
func doTick(ctx context.Context, providers []Provider, pair TestPair, region string) {
	var wg sync.WaitGroup
	for _, p := range providers {
		if !p.Supports(pair.ChainId) {
			continue
		}
		wg.Add(1)
		go func(p Provider) {
			defer wg.Done()
			probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			ms, ok, err := p.Probe(probeCtx, pair)
			if ok {
				RecordLatency(p.Slug(), pair.Chain, region, ms)
				fmt.Printf("[%s] %s %s/%s -> %s/%s : %dms\n",
					region, p.Slug(), pair.TokenInSym, pair.TokenOutSym, pair.Chain, pair.TokenOutSym, ms)
			} else if err != nil {
				// Most adapters already recorded the correct counter — this
				// line is just for the log ring buffer so /logs?tail=N is
				// useful when debugging a stuck provider.
				fmt.Printf("[%s] %s %s/%s on %s: FAIL %v\n",
					region, p.Slug(), pair.TokenInSym, pair.TokenOutSym, pair.Chain, err)
			}
		}(p)
	}
	wg.Wait()
}
