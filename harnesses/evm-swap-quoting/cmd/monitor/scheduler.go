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
// 0x is back, gated by ZEROX_API_KEY.
//
// It was dropped in #508 under a comment claiming their team had
// suspended the account because benchmarking without filling is a
// TOS-defined abuse signal. Nothing in this repo backs that: no mail,
// no ticket, no log, no mention in the harness README, and the commit
// carries only the code removal. The key that was on the services
// answered 403 "You cannot consume this service", which names a
// service and not an account, and a key issued on 2026-10-19 under the
// same 0x account with the Swap API service ticked works immediately
// on Ethereum and Base. The earlier claim looks like an inference that
// hardened into a fact.
//
// The general concern it raised is still worth watching, so the error
// counters are the place to find out: a 403 returning here would be
// evidence, dated and with the message attached, which is what the
// original claim lacked.
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
	if cfg.ZeroExAPIKey != "" {
		providers = append(providers, NewZeroExProvider(cfg.MonitorRegion, cfg.ZeroExAPIKey))
	}
	if cfg.OdosAPIKey != "" {
		providers = append(providers, NewOdosProvider(cfg.MonitorRegion, cfg.OdosAPIKey))
	}
	if cfg.UniswapAPIKey != "" {
		providers = append(providers, NewUniswapProvider(cfg.MonitorRegion, cfg.UniswapAPIKey))
	}
	if cfg.RouteAPIKey != "" {
		providers = append(providers, NewRouteProvider(cfg.MonitorRegion, cfg.RouteAPIKey))
	}
	return providers
}

// runScheduler ticks every 60s and rotates through the test basket
// (one pair per tick, round-robin). On each tick we fan out one Probe per
// (provider, pair) combo in parallel. Providers that don't Supports() the
// pair's chain are skipped silently.
//
// At basket size = 6 and tick = 60s, each (provider, chain, pair) sees a
// quote every 6 minutes = 240 samples per 24h, which is enough to land the
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
	// Quotes from this tick, kept so the shortfall can be measured against
	// the best of them. The market moves 30 to 37 bps over five minutes
	// while providers sit within 25 of each other, so a quote is only
	// comparable to the ones fired beside it.
	var mu sync.Mutex
	tickQuotes := map[string]Quote{}
	for _, p := range providers {
		if !p.Supports(pair.ChainId) {
			continue
		}
		wg.Add(1)
		go func(p Provider) {
			defer wg.Done()
			probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
			defer cancel()
			q, err := p.Probe(probeCtx, pair)
			if q.OK {
				mu.Lock()
				tickQuotes[p.Slug()] = q
				mu.Unlock()
				RecordLatency(p.Slug(), pair.Chain, region, q.LatencyMs)
				RecordQuote(p.Slug(), pair, region, q)
				fmt.Printf("[%s] %s %s/%s -> %s/%s : %dms out=%s\n",
					region, p.Slug(), pair.TokenInSym, pair.TokenOutSym, pair.Chain,
					pair.TokenOutSym, q.LatencyMs, q.OutAmount)
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
	RecordShortfall(pair, region, tickQuotes)
}
