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
	installLogCapture() // capture stdout into /logs ring buffer
	fmt.Println("=== Perp Fees Monitor ===")
	fmt.Println("Bench № 007 — measures all-in opening cost on perp venues from public APIs only.")
	fmt.Println()

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
		runRefreshLoop(cfg, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runRefreshLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.Interval)
	defer tick.Stop()

	fetchAll(cfg)

	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fetchAll(cfg)
		}
	}
}

func fetchAll(cfg *Config) {
	var wg sync.WaitGroup
	for _, v := range cfg.Venues {
		v := v
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := fetchOne(v, cfg)
			recordSample(s)
			recordDebugSnapshot(s)
			if s.Err != "" {
				fmt.Printf("[PERP][%s/%s] ERROR after %dms: %s\n", v.Slug, v.Asset, s.FetchLatencyMs, s.Err)
			} else {
				fmt.Printf("[PERP][%s/%s] all_in=%.2fbps (taker=%.2f, spread=%.2f, funding=%.4fbps/h, mid=$%.2f) in %dms\n",
					v.Slug, v.Asset, s.AllInBps, s.TakerFeeBps, s.SpreadBps, s.FundingRatePerHrBps, s.MidPrice, s.FetchLatencyMs)
				for _, t := range s.Tiers {
					fmt.Printf("[PERP][%s/%s]   tier $%s: all_in=%.2fbps (spread=%.2f)\n", v.Slug, v.Asset, t.Notional, t.AllInBps, t.SpreadBps)
				}
				for _, n := range s.SkippedTiers {
					fmt.Printf("[PERP][%s/%s]   tier $%s: SKIPPED (book depth insufficient)\n", v.Slug, v.Asset, n)
				}
			}
		}()
	}
	wg.Wait()
}

func fetchOne(v VenueConfig, cfg *Config) PerpSample {
	switch v.Slug {
	case "hyperliquid":
		return fetchHyperliquid(v)
	case "dydx":
		return fetchDYdX(v)
	case "gmx":
		return fetchGMX(v)
	case "lighter":
		return fetchLighter(v)
	case "gains":
		return fetchGains(v, cfg.MobulaAPIKey)
	default:
		return PerpSample{Venue: v.Slug, Asset: v.Asset, Err: "unsupported_venue"}
	}
}
