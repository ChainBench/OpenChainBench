// pm-cohort-stats is a small Prom-exporter harness that polls prediction
// market data sources and exposes per-venue cohort gauges the OCB site
// renders on the PM benches strip and the /benches/pm-* product pages.
//
//	=== Gauges exposed ===============================================
//	pm_venue_volume_30d_usd{venue}            Notional vol rolling 30d
//	pm_venue_volume_24h_usd{venue}            Notional vol last 24h
//	pm_venue_open_interest_usd{venue}         Current OI
//	pm_venue_active_markets{venue}            Open markets right now
//	pm_venue_top_market_volume_24h_usd{venue} Highest single market 24h
//	pm_venue_markets_above_1m{venue}          Markets crossed $1m all-time
//
// Each gauge is publish-then-leave: if a fetch fails for one venue on
// one source, the previous value carries forward via Prom retention,
// other venues are unaffected, and the error is bucketed in
// pm_cohort_stats_fetch_errors_total{venue, source, error_type}.
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
	fmt.Println("=== pm-cohort-stats harness ===")
	fmt.Println("Per-venue PM cohort stats from Polymarket gamma, Kalshi REST, Limitless REST, Myriad v2, Manifold, and DefiLlama.")
	fmt.Println("Exposes /metrics on :2112.")

	cfg := loadConfig()

	// Parse the Kalshi RSA private key once at startup. If absent, the
	// trades-aggregation path silently no-ops; the public marketsCatalog
	// path still populates active count + OI.
	initKalshiAuth(cfg.KalshiKeyID, cfg.KalshiPrivateKey)

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
		runPolymarketLoop(cfg, stop)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runKalshiLoop(cfg, stop)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runDefillamaLoop(cfg, stop)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runLimitlessLoop(cfg, stop)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runMyriadLoop(cfg, stop)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runManifoldLoop(cfg, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runPolymarketLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.PolymarketRefreshInterval)
	defer tick.Stop()

	fetchAllPolymarket()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAllPolymarket()
		}
	}
}

func runKalshiLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.KalshiRefreshInterval)
	defer tick.Stop()

	fetchAllKalshi()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAllKalshi()
		}
	}
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

func runLimitlessLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.LimitlessRefreshInterval)
	defer tick.Stop()

	fetchAllLimitless()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAllLimitless()
		}
	}
}

func runMyriadLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.MyriadRefreshInterval)
	defer tick.Stop()

	fetchAllMyriad()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAllMyriad()
		}
	}
}

func runManifoldLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.ManifoldRefreshInterval)
	defer tick.Stop()

	fetchAllManifold(cfg.ManifoldManaUsdRate)
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAllManifold(cfg.ManifoldManaUsdRate)
		}
	}
}
