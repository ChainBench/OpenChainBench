package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const (
	tickInterval = 60 * time.Minute
	probeTimeout = 10 * time.Second
	fetchTimeout = 30 * time.Second
)

// buildProviders returns all configured providers.
func buildProviders(cfg *Config) []Provider {
	providers := []Provider{
		NewJupiterProvider(),
		NewMobulaProvider(cfg.MobulaAPIKey),
		NewKyberSwapProvider(),
		NewOKXDEXProvider(cfg.OKXDEXAPIKey),
		NewOdosProvider(),
	}
	return providers
}

// runScheduler fires immediately then every 60 minutes.
func runScheduler(cfg *Config, stopChan <-chan struct{}) {
	providers := buildProviders(cfg)
	fmt.Printf("[SCHED] starting with %d providers, region=%s\n", len(providers), cfg.MonitorRegion)
	for _, p := range providers {
		fmt.Printf("[SCHED]   - %s\n", p.Slug())
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tick := time.NewTicker(tickInterval)
	defer tick.Stop()

	doTick(ctx, providers)

	for {
		select {
		case <-stopChan:
			return
		case <-tick.C:
			doTick(ctx, providers)
		}
	}
}

// doTick fetches tokens from Dexscreener and probes all providers in parallel.
func doTick(ctx context.Context, providers []Provider) {
	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	fmt.Println("[SCHED] fetching boosted tokens from Dexscreener")
	entries, err := FetchBoostedTokens(fetchCtx)
	if err != nil {
		fmt.Printf("[SCHED] FetchBoostedTokens error: %v\n", err)
		return
	}
	if len(entries) == 0 {
		fmt.Println("[SCHED] warning: Dexscreener returned 0 tokens")
		return
	}
	fmt.Printf("[SCHED] got %d boosted tokens, enriching with venue data\n", len(entries))

	tokens, err := EnrichWithVenue(fetchCtx, entries)
	if err != nil {
		fmt.Printf("[SCHED] EnrichWithVenue error: %v\n", err)
		return
	}
	if len(tokens) == 0 {
		fmt.Println("[SCHED] warning: no tokens survived venue enrichment")
		return
	}
	fmt.Printf("[SCHED] probing %d tokens across %d providers\n", len(tokens), len(providers))

	var wg sync.WaitGroup
	for _, tok := range tokens {
		for _, p := range providers {
			if !p.SupportsChain(tok.Chain) {
				continue
			}
			wg.Add(1)
			go func(p Provider, tok Token) {
				defer wg.Done()
				probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
				defer cancel()
				ok := p.Quote(probeCtx, tok)
				status := "miss"
				if ok {
					status = "HIT"
				}
				fmt.Printf("[probe] %s %s/%s venue=%s -> %s\n",
					p.Slug(), tok.Chain, tok.Address[:min(8, len(tok.Address))], tok.Venue, status)
			}(p, tok)
		}
	}
	wg.Wait()
	fmt.Println("[SCHED] tick complete")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
