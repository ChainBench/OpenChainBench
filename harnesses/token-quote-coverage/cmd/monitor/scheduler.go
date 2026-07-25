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
		NewRaydiumProvider(),
		NewMobulaProvider(cfg.MobulaAPIKey),
		NewKyberSwapProvider(),
		NewParaSwapProvider(),
		NewOpenOceanProvider(),
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

// doTick fetches tokens from all discovery sources in parallel, merges, and probes.
func doTick(ctx context.Context, providers []Provider) {
	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	// Fetch from all discovery sources concurrently: Dexscreener boosts (Solana +
	// Robinhood), Virtuals Protocol API (Base), GeckoTerminal new pools (BSC).
	type result struct {
		name    string
		entries []boostEntry
		err     error
	}
	ch := make(chan result, 3)
	go func() {
		e, err := FetchBoostedTokens(fetchCtx)
		ch <- result{"dexscreener-boosts", e, err}
	}()
	go func() {
		e, err := FetchVirtualsTokens(fetchCtx)
		ch <- result{"virtuals", e, err}
	}()
	go func() {
		e, err := FetchNewBSCTokens(fetchCtx)
		ch <- result{"geckoterminal-bsc", e, err}
	}()

	seen := map[string]bool{}
	var entries []boostEntry
	for i := 0; i < 3; i++ {
		r := <-ch
		if r.err != nil {
			fmt.Printf("[SCHED] %s error: %v\n", r.name, r.err)
			continue
		}
		for _, e := range r.entries {
			key := e.ChainId + ":" + e.TokenAddress
			if !seen[key] {
				seen[key] = true
				entries = append(entries, e)
			}
		}
		fmt.Printf("[SCHED] %s: %d tokens\n", r.name, len(r.entries))
	}

	if len(entries) == 0 {
		fmt.Println("[SCHED] warning: all discovery sources returned 0 tokens")
		return
	}
	fmt.Printf("[SCHED] %d unique tokens across all chains, enriching with venue data\n", len(entries))

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
