// chain-kpis is a small Prom-exporter harness that polls DefiLlama and
// Mobula for per-chain KPIs the OCB site renders on /chains/<slug>.
//
//	─── Gauges exposed ───────────────────────────────────────────────
//	chain_tvl_usd{chain}                       — DefiLlama TVL
//	chain_dex_volume_24h_usd{chain}            — DefiLlama 24h DEX vol
//	chain_stables_mcap_usd{chain}              — DefiLlama stables mcap
//	chain_native_price_usd{chain, symbol}      — Mobula native price
//	chain_native_mcap_usd{chain, symbol}       — Mobula native mcap
//	chain_mobula_tokens_indexed{chain}         — Mobula tokens count
//
// Each gauge is publish-then-leave: if a fetch fails for one chain on
// one source, the previous value carries forward via Prom retention,
// other chains are unaffected, and the error is bucketed in
// chain_kpis_fetch_errors_total{chain, source, error_type}.
//
// HTTP server is fixed at :2112 per the OCB harness convention (see
// CLAUDE.md memory note: every OCB harness on Railway hard-codes :2112
// so the shared Prom-gateway scrape target matches).
package main

import (
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func main() {
	fmt.Println("=== chain-kpis harness ===")
	fmt.Println("Per-chain TVL + DEX vol + stables (DefiLlama) and native price + mcap + tokens (Mobula).")
	fmt.Println("Exposes /metrics on :2112.")

	cfg := loadConfig()

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
		runDefillamaLoop(cfg, stop)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runMobulaLoop(cfg, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runDefillamaLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.DefillamaRefreshInterval)
	defer tick.Stop()

	fetchAllDefillama()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAllDefillama()
		}
	}
}

func runMobulaLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.MobulaRefreshInterval)
	defer tick.Stop()

	fetchAllMobula(cfg)
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAllMobula(cfg)
		}
	}
}
