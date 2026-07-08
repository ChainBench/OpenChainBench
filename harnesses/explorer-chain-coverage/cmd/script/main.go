// explorer-chain-coverage measures how many blockchains each block
// explorer family actually serves with a WORKING indexer — split into
// honest per-provider numbers:
//
//	explorer_chains_registered{provider, registered_source}
//	explorer_chains_verified{provider}   freshness-gated live count
//	explorer_chains_top50{provider}      coverage of the 50 most
//	                                     active mainnets
//
// registered is what the family self-declares via a machine-readable
// surface; verified only counts chains whose latest indexed block is
// younger than the freshness window (a reachable web server with a
// stalled indexer does not count); top50 is the anti-inflation view
// (raw counts reward hosting ghost rollups). The gaps between the
// three are the story: marketing claims like "3000+ chains" are
// unverifiable by anyone, registries rot, and the fresh-indexed
// number is what integrators can actually build on today.
//
// Every surface in the cohort is free; two families need free
// self-serve keys (Etherscan, Subscan, OKLink) and are skipped
// gracefully without them. Cycle default 24h. Quota-truncated cycles
// publish nothing (publish-then-leave).
//
// HTTP server on :2112 per OCB harness convention.
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

// providerSpacing is the pause between two sequential provider probes.
const providerSpacing = 5 * time.Second

func main() {
	installLogCapture()
	fmt.Println("=== explorer-chain-coverage harness ===")
	fmt.Println("OpenChainBench - block explorer chain coverage: registered vs fresh-indexed.")
	fmt.Println("Exposes /metrics on :2112.")
	fmt.Println()

	cfg := loadConfig()
	for _, p := range Registry {
		if p.KeyEnv == "" {
			fmt.Printf("  - %-11s keyless\n", p.Slug)
			continue
		}
		fmt.Printf("  - %-11s key_env=%s key_set=%v\n",
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

var skipLogged = map[string]bool{}

func runCycle() {
	fmt.Printf("[cycle] starting probe cycle at %s\n", time.Now().UTC().Format(time.RFC3339))
	first := true

	for _, p := range Registry {
		key := ""
		if p.KeyEnv != "" {
			key = strings.TrimSpace(os.Getenv(p.KeyEnv))
			if key == "" {
				if !skipLogged[p.Slug] {
					fmt.Printf("[cycle] skipping %s: %s is empty (free self-serve key enables it)\n", p.Slug, p.KeyEnv)
					skipLogged[p.Slug] = true
				}
				continue
			}
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

// publish writes one provider's coverage. Fields at -1 are unknown
// this cycle and left untouched (publish-then-leave).
func publish(slug string, cov coverage) {
	published := false
	if cov.registered >= 0 {
		explorerChainsRegistered.WithLabelValues(slug, cov.registeredSource).Set(float64(cov.registered))
		published = true
	}
	if cov.verified >= 0 {
		explorerChainsVerified.WithLabelValues(slug).Set(float64(cov.verified))
		published = true
	}
	if cov.verifiedStrict >= 0 {
		explorerChainsVerifiedStrict.WithLabelValues(slug).Set(float64(cov.verifiedStrict))
		published = true
	}
	if cov.top50 >= 0 {
		explorerChainsTop50.WithLabelValues(slug).Set(float64(cov.top50))
		published = true
	}
	if cov.latencyMs > 0 {
		explorerProbeLatencyMs.WithLabelValues(slug).Set(cov.latencyMs)
	}
	if published {
		explorerLastProbeTimestamp.WithLabelValues(slug).Set(float64(time.Now().Unix()))
	}
	fmt.Printf("[%s] registered=%d (source=%s) verified=%d strict5m=%d top50=%d latency_ms=%.0f\n",
		slug, cov.registered, cov.registeredSource, cov.verified, cov.verifiedStrict, cov.top50, cov.latencyMs)
}
