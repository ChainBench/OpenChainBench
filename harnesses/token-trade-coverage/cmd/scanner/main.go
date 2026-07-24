// Materialize the token-trade-coverage bench (№ 090).
//
// Loop: every SWEEP_SEC, iterate every (provider, chain, token) tuple,
// fetch trades in the same rolling 60-minute window, compute the union
// baseline per (chain, token) as max(counts) across providers and
// publish capture rate + companion metrics to Prometheus.
//
// The design keeps memory bounded: providers return counts, not trade
// arrays, so a token with 50k trades in the window costs O(1) here.

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var providers = []string{"mobula", "bitquery", "codex"}

func main() {
	cfg := LoadConfig()
	log.Printf("[boot] sweep=%ds providers=%v tokens=%d", cfg.SweepSec, providers, len(cfg.Tokens))

	// Expose /metrics before the first sweep so Prom starts scraping
	// immediately; capture_pct just stays 0 until the loop populates it.
	http.Handle("/metrics", promhttp.Handler())
	go func() {
		addr := ":" + cfg.MetricsPort
		log.Printf("[boot] metrics on %s/metrics", addr)
		if err := http.ListenAndServe(addr, nil); err != nil {
			log.Fatalf("http: %v", err)
		}
	}()

	client := &http.Client{Timeout: cfg.HTTPTimeout()}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	ticker := time.NewTicker(time.Duration(cfg.SweepSec) * time.Second)
	defer ticker.Stop()

	// First sweep runs immediately at boot so Prom sees data within
	// SWEEP_SEC + measurement time rather than waiting a full cycle.
	iteration := 0
	sweep(ctx, cfg, client, iteration)
	for {
		select {
		case <-ctx.Done():
			log.Printf("[shutdown] signal received")
			return
		case <-ticker.C:
			iteration++
			sweep(ctx, cfg, client, iteration)
		}
	}
}

// providerEnabled reports whether the provider should run on this
// iteration given its sub-sampling cadence (see Config.*EveryN).
func providerEnabled(cfg *Config, provider string, iteration int) bool {
	var everyN int
	switch provider {
	case "mobula":
		everyN = cfg.MobulaEveryN
	case "bitquery":
		everyN = cfg.BitqueryEveryN
	case "codex":
		everyN = cfg.CodexEveryN
	default:
		return false
	}
	if everyN <= 1 {
		return true
	}
	return iteration%everyN == 0
}

// sweep runs one full measurement cycle. For each token, we fan out
// across every supported provider in parallel, wait for all to finish
// (or fail), compute the union baseline as max(counts) and emit.
//
// `iteration` is the 0-indexed sweep counter — used for per-provider
// sub-sampling (see providerEnabled). Skipped providers keep their
// previous capture_pct value in Prom, which `avg_over_time([24h])`
// then averages across the sparse sample.
func sweep(ctx context.Context, cfg *Config, client *http.Client, iteration int) {
	sweepStart := time.Now()
	windowEnd := sweepStart.UnixMilli()
	windowStart := windowEnd - cfg.MeasurementWinMs

	activeProviders := make([]string, 0, len(providers))
	for _, p := range providers {
		if providerEnabled(cfg, p, iteration) {
			activeProviders = append(activeProviders, p)
		}
	}
	log.Printf("[sweep] iter=%d active=%v", iteration, activeProviders)

	for _, tok := range cfg.Tokens {
		if tok.Address == "" {
			// Placeholder row (Stellar addresses TBD). Skip silently
			// so the container doesn't spam warnings until they land.
			continue
		}
		results := make([]Result, 0, len(activeProviders))
		var mu sync.Mutex
		var wg sync.WaitGroup

		for _, p := range activeProviders {
			if !cfg.Supports(p, tok.Chain) {
				continue
			}
			wg.Add(1)
			go func(p string) {
				defer wg.Done()
				start := time.Now()
				count, dex, err := fetchOne(ctx, client, cfg, p, tok, windowStart, windowEnd)
				latMs := float64(time.Since(start).Milliseconds())
				r := Result{
					Provider:  p,
					Chain:     tok.Chain,
					Token:     tok.Symbol,
					Count:     count,
					DexCount:  dex,
					LatencyMs: latMs,
					OK:        err == nil,
				}
				if err != nil {
					log.Printf("[%s][%s/%s] err: %v", p, tok.Chain, tok.Symbol, err)
				} else {
					log.Printf("[%s][%s/%s] count=%d dex=%d %.0fms", p, tok.Chain, tok.Symbol, count, dex, latMs)
				}
				mu.Lock()
				results = append(results, r)
				mu.Unlock()
			}(p)
		}
		wg.Wait()

		// Union baseline: the largest count observed across providers
		// that succeeded. If every provider failed the baseline is 0
		// and capture rate stays 0 across the board (spec `success`
		// query then flags the (chain, token) as unresponsive).
		unionMax := 0
		for _, r := range results {
			if r.OK && r.Count > unionMax {
				unionMax = r.Count
			}
		}
		emitCycle(results, unionMax)
	}
	log.Printf("[sweep] done in %.1fs", time.Since(sweepStart).Seconds())
}

// fetchOne dispatches to the provider-specific fetcher, threading each
// provider's page/row cap so a runaway pagination loop can never drain
// a monthly quota in a single sweep.
func fetchOne(
	ctx context.Context,
	client *http.Client,
	cfg *Config,
	provider string,
	tok Token,
	windowStart, windowEnd int64,
) (int, int, error) {
	switch provider {
	case "mobula":
		return fetchMobula(ctx, client, cfg.MobulaKey, tok, windowStart, windowEnd, cfg.MobulaMaxPages)
	case "bitquery":
		return fetchBitquery(ctx, client, cfg.BitqueryKey, tok, windowStart, windowEnd, cfg.BitqueryMaxRows)
	case "codex":
		return fetchCodex(ctx, client, cfg.CodexKey, tok, windowStart, windowEnd, cfg.CodexMaxPages)
	}
	return 0, 0, fmt.Errorf("unknown provider %s", provider)
}
