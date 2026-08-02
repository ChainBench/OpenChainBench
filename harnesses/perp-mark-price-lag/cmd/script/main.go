// perp-mark-price-lag -- Bench 118
//
// Measures how far each perp DEX mark price sits from a Binance spot
// reference on ETH, BTC and SOL, sampled every 60 seconds.
//
// Oracle-priced venues (gains, gmx) are represented by their Pyth price
// feed, which structurally tracks CEX spot within 1 bps. Orderbook venues
// (hyperliquid, dydx, lighter, paradex) publish their own mark prices.
// Reference is Binance REST bookTicker mid.
//
// Metrics exposed on :2112/metrics:
//   perp_mark_deviation_bps{venue, chain}         -- primary
//   perp_mark_deviation_signed_bps{venue, chain}
//   perp_mark_reference_price_usd{chain}
//   perp_mark_price_usd{venue, chain}
//   perp_mark_health{venue, chain}
//   perp_mark_fetch_latency_milliseconds{venue, chain}
//   perp_mark_fetch_errors_total{venue, chain, error_type}
//   perp_mark_last_refresh_timestamp_seconds{venue, chain}
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
	fmt.Println("=== perp-mark-price-lag harness ===")
	fmt.Println("Bench 118 -- mark price deviation from Binance spot reference.")
	fmt.Println("Exposes /metrics, /health on :2112.")

	cfg := loadConfig()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := StartMetricsServer(":2112"); err != nil {
			fmt.Printf("metrics server error: %v\n", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runRefreshLoop(cfg, stop)
	}()

	<-sigChan
	fmt.Println("shutting down")
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
	// 1. Build reference prices for all assets in one batch.
	refs := fetchAllReferences()

	// 2. Fetch mark prices per venue x asset in parallel.
	var wg sync.WaitGroup
	for _, v := range cfg.Venues {
		v := v
		ref := refs[v.Asset]
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := fetchOne(v, ref)
			recordSample(s)
			if s.Err != "" {
				fmt.Printf("[MARK][%s/%s] ERROR: %s\n", v.Slug, v.Asset, s.Err)
			} else {
				fmt.Printf("[MARK][%s/%s] mark=%.4f ref=%.4f dev=%.3fbps signed=%.3fbps in %dms\n",
					v.Slug, v.Asset, s.MarkPrice, s.RefPrice, s.DeviationBps, s.SignedBps, s.FetchLatMs)
			}
		}()
	}
	wg.Wait()
}

func fetchOne(v VenueConfig, ref float64) MarkSample {
	switch v.Slug {
	case "gains":
		return fetchOracleVenue(v, ref, "gains")
	case "gmx":
		return fetchOracleVenue(v, ref, "gmx")
	case "hyperliquid":
		return fetchHyperliquidMark(v, ref)
	case "dydx":
		return fetchDYdXMark(v, ref)
	case "lighter":
		return fetchLighterMark(v, ref)
	case "paradex":
		return fetchParadexMark(v, ref)
	default:
		return MarkSample{Venue: v.Slug, Asset: v.Asset, Err: "unsupported_venue"}
	}
}

func nowUnix() int64 {
	return time.Now().Unix()
}
