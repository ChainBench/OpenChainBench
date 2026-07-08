// perp-execution-scanner is a Prom-exporter harness that publishes live
// per-venue execution quality gauges for the OCB perp-execution-quality
// bench.
//
// Each tick (default 30s) it polls the visible orderbook on every listed
// venue, computes:
//   - top-of-book bid / ask / mid / spread bps
//   - simulated market-order slippage at every SizeBucket, per side
//   - max fillable USD notional on both sides
//
// No trades are placed; everything is derived from public REST endpoints
// (Lighter /orderBookOrders, Hyperliquid POST /info l2Book). No auth.
//
// The exposed HTTP server is fixed at :2112 to match the OCB Railway /
// VPS scrape convention.
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
	installLogCapture()
	fmt.Println("=== perp-execution-scanner harness ===")
	fmt.Println("Live per-venue market-order slippage for the OCB perp-execution-quality bench.")
	fmt.Println("Exposes /metrics, /health, /logs on the configured LISTEN_ADDR (default :2112).")

	cfg := loadConfig()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		fmt.Printf("Starting Prometheus metrics server on %s\n", cfg.ListenAddr)
		if err := StartMetricsServer(cfg.ListenAddr); err != nil {
			fmt.Printf("Metrics server error: %v\n", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runSweepLoop(cfg, stop)
	}()

	<-sigChan
	fmt.Println("\nShutting down...")
	close(stop)
	wg.Wait()
}

func runSweepLoop(cfg *Config, stop <-chan struct{}) {
	tick := time.NewTicker(cfg.TickInterval)
	defer tick.Stop()

	sweep(cfg)
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			sweep(cfg)
		}
	}
}

// sweep fans out one goroutine per (asset, venue) pair. Slippage compute
// is CPU-cheap so the wait for orderbook JSON dominates. Timeout inside
// each source is 10s, so worst-case tick wall-clock is bounded regardless
// of upstream latency.
func sweep(cfg *Config) {
	lastTickGauge.Set(float64(time.Now().Unix()))

	var wg sync.WaitGroup
	for _, asset := range cfg.Assets {
		asset := asset

		wg.Add(1)
		go func() {
			defer wg.Done()
			start := time.Now()
			book, err := FetchLighter(asset.Asset, asset.LighterMarketID)
			if err != nil {
				fetchErrorsCtr.WithLabelValues(asset.Asset, "lighter", classifyError(err.Error())).Inc()
				healthGauge.WithLabelValues(asset.Asset, "lighter").Set(0)
				fmt.Printf("[%s][lighter] err: %v\n", asset.Asset, err)
				return
			}
			publish(book, cfg, time.Since(start))
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			start := time.Now()
			book, err := FetchHyperliquid(asset.Asset, asset.HyperliquidCoin)
			if err != nil {
				fetchErrorsCtr.WithLabelValues(asset.Asset, "hyperliquid", classifyError(err.Error())).Inc()
				healthGauge.WithLabelValues(asset.Asset, "hyperliquid").Set(0)
				fmt.Printf("[%s][hyperliquid] err: %v\n", asset.Asset, err)
				return
			}
			publish(book, cfg, time.Since(start))
		}()
	}
	wg.Wait()
}

// publish drives every gauge for a single (asset, venue) book. Called
// once the fetch succeeded; failure paths increment fetch_errors and
// flip health to 0 back at the sweep site.
func publish(book *OrderBook, cfg *Config, latency time.Duration) {
	asset, venue := book.Asset, book.Venue

	mid := Mid(book)
	if mid == 0 {
		fetchErrorsCtr.WithLabelValues(asset, venue, "empty_book").Inc()
		healthGauge.WithLabelValues(asset, venue).Set(0)
		fmt.Printf("[%s][%s] empty book (bids=%d asks=%d)\n", asset, venue, len(book.Bids), len(book.Asks))
		return
	}

	topBidGauge.WithLabelValues(asset, venue).Set(book.Bids[0].Price)
	topAskGauge.WithLabelValues(asset, venue).Set(book.Asks[0].Price)
	spreadGauge.WithLabelValues(asset, venue).Set(SpreadBps(book))
	lastScrapeGauge.WithLabelValues(asset, venue).Set(float64(book.ScrapeTs))
	fetchLatencyGauge.WithLabelValues(asset, venue).Set(float64(latency.Milliseconds()))
	healthGauge.WithLabelValues(asset, venue).Set(1)

	// Buy walk: walk asks ascending. Sell walk: walk bids descending.
	// The venues return each side already in the right order for us.
	maxBuyFill := walkMax(book.Asks)
	maxSellFill := walkMax(book.Bids)
	maxFillableGauge.WithLabelValues(asset, venue, "buy").Set(maxBuyFill)
	maxFillableGauge.WithLabelValues(asset, venue, "sell").Set(maxSellFill)

	// Per size bucket, both sides. When the book doesn't have depth
	// for the requested size, we skip the slippage gauge (the API
	// contract says NaN would break some downstream consumers; the
	// max_fillable gauge above is the caller's signal).
	for _, size := range cfg.SizeBuckets {
		label := sizeLabel(size)

		buyBps, _, buyOk := WalkOrderbook(book.Asks, size, mid)
		if buyOk {
			slippageGauge.WithLabelValues(asset, venue, "buy", label).Set(buyBps)
		} else {
			slippageGauge.DeleteLabelValues(asset, venue, "buy", label)
		}

		// Sell side: walking bids descending gives an avg execution
		// price BELOW mid, so slippageBps comes back negative. Flip
		// the sign so the metric is always "cost to the trader" >= 0
		// in the happy path.
		sellBps, _, sellOk := WalkOrderbook(book.Bids, size, mid)
		if sellOk {
			slippageGauge.WithLabelValues(asset, venue, "sell", label).Set(-sellBps)
		} else {
			slippageGauge.DeleteLabelValues(asset, venue, "sell", label)
		}
	}

	// One-line summary at the $10k reference size so the ops loop
	// (docker logs / /logs endpoint) shows execution quality live.
	refSize := 10000.0
	refLabel := sizeLabel(refSize)
	refBuy, _, _ := WalkOrderbook(book.Asks, refSize, mid)
	fmt.Printf("[%s][%s] mid=%.4f spread=%.1fbps slip$%s_buy=%.1fbps maxbuy=%.0f maxsell=%.0f lat=%dms\n",
		asset, venue, mid, SpreadBps(book), refLabel, refBuy, maxBuyFill, maxSellFill, latency.Milliseconds())
}

// walkMax returns the total USD notional visible on the given side of
// the book, capped at 10M so a garbage row can't blow the gauge up.
func walkMax(side []Level) float64 {
	var total float64
	for _, l := range side {
		if l.Price <= 0 || l.Size <= 0 {
			continue
		}
		total += l.Price * l.Size
		if total > 10_000_000 {
			return 10_000_000
		}
	}
	return total
}
