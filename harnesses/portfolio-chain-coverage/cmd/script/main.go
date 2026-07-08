// portfolio-chain-coverage is a small Prom-exporter harness that
// measures how many blockchains each wallet-portfolio API vendor
// actually covers — split into two honest numbers per provider:
//
//	portfolio_chains_listed{provider, listed_source}  self-declared
//	portfolio_chains_verified{provider}               probe-verified
//
// "listed" is what the vendor claims via a machine-readable catalog
// endpoint; "verified" is the number of chains where their portfolio
// API returned a real balance (> $1) for canonical high-activity test
// addresses shared identically across every provider. The gap between
// the two is the story the bench tells.
//
// Probes run once per PROBE_INTERVAL_HOURS (default 24h — the calls
// spend paid API credits, ~300-340 calls per cycle across the cohort,
// so never lower the default). Gauges are publish-then-leave: a failed
// cycle for one provider carries the previous value forward via Prom
// retention and buckets the failure in portfolio_probe_errors_total.
//
// HTTP server is fixed at :2112 per the OCB harness convention so the
// shared Prometheus scrape target matches every other harness.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// providerSpacing is the pause between two sequential provider
// probes inside one cycle. Keeps the harness from looking like a
// burst client to any shared upstream edge.
const providerSpacing = 5 * time.Second

func main() {
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== portfolio-chain-coverage harness ===")
	fmt.Println("OpenChainBench - wallet-portfolio API chain coverage: self-declared vs probe-verified.")
	fmt.Println("Exposes /metrics on :2112.")
	fmt.Println()

	cfg := loadConfig()
	for _, p := range Registry {
		fmt.Printf("  - %-10s key_env=%s key_set=%v\n",
			p.Slug, p.KeyEnv, strings.TrimSpace(os.Getenv(p.KeyEnv)) != "")
	}
	fmt.Println()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Println("Starting Prometheus metrics server on :2112")
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("Metrics server error: %v\n", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runProbeLoop(cfg, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runProbeLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.ProbeInterval)
	defer tick.Stop()

	// SKIP_INITIAL_CYCLE=1 suppresses the startup probe. Set it on
	// deploy-storm days: every container restart otherwise runs a
	// full cycle, and 7 redeploys in one day burned a month of
	// CoinStats credits on 2026-07-07. Steady state leaves it unset
	// so a normal deploy refreshes the gauges immediately.
	if envDefault("SKIP_INITIAL_CYCLE", "") == "1" {
		fmt.Println("[cycle] SKIP_INITIAL_CYCLE=1: waiting for the first tick")
	} else {
		runCycle()
	}
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			runCycle()
		}
	}
}

// skipLogged remembers which keyless providers were already announced
// so the skip line is logged once, not once per day. Only touched from
// the single probe goroutine, so no lock is needed.
var skipLogged = map[string]bool{}

// runCycle runs one full probe pass: sequential providers with 5s
// spacing. Providers whose key env var is empty are skipped gracefully
// so the harness keeps publishing a partial cohort.
func runCycle() {
	fmt.Printf("[cycle] starting probe cycle at %s\n", time.Now().UTC().Format(time.RFC3339))
	first := true

	for _, p := range Registry {
		key := strings.TrimSpace(os.Getenv(p.KeyEnv))
		if key == "" {
			if !skipLogged[p.Slug] {
				fmt.Printf("[cycle] skipping %s: %s is empty (set it to enable this provider)\n", p.Slug, p.KeyEnv)
				skipLogged[p.Slug] = true
			}
			continue
		}

		if !first {
			time.Sleep(providerSpacing)
		}
		first = false

		fmt.Printf("[%s] probing...\n", p.Slug)
		cov := p.Probe(key)
		publish(p.Slug, cov)
	}
	fmt.Printf("[cycle] probe cycle complete\n")
}

// publish writes one provider's coverage into the gauges. Fields at
// -1 are unknown this cycle and left untouched (publish-then-leave).
func publish(slug string, cov coverage) {
	published := false
	if cov.listed >= 0 {
		portfolioChainsListed.WithLabelValues(slug, cov.listedSource).Set(float64(cov.listed))
		published = true
	}
	if cov.verified >= 0 {
		portfolioChainsVerified.WithLabelValues(slug).Set(float64(cov.verified))
		published = true
	}
	if cov.probed >= 0 {
		portfolioChainsProbed.WithLabelValues(slug).Set(float64(cov.probed))
		published = true
	}
	if cov.latencyMs > 0 {
		portfolioProbeLatencyMs.WithLabelValues(slug).Set(cov.latencyMs)
	}
	if published {
		portfolioLastProbeTimestamp.WithLabelValues(slug).Set(float64(time.Now().Unix()))
	}
	fmt.Printf("[%s] listed=%d (source=%s) probed=%d verified=%d latency_ms=%.0f\n",
		slug, cov.listed, cov.listedSource, cov.probed, cov.verified, cov.latencyMs)
}
