package main

// Hyperliquid frontends quality benchmark.
//
// Pulls the per-builder, per-day fills CSV that the Hyperliquid team
// publishes at https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/
// then computes three quality metrics per builder:
//
//   - effective_fee_bps   = sum(builder_fee) / sum(notional) * 10000
//   - fees_per_user_usd   = sum(builder_fee) / count(distinct user)
//   - volume_usd_24h      = sum(px * sz)
//
// 30-day fee discipline is NOT computed here — it falls out for free
// via `stddev_over_time(hl_frontend_effective_fee_bps[30d])` in
// Prometheus once the time-series accumulates.
//
// MVP shape — wire it up, point at the public bucket, expose Prom on
// :2112. Builder address registry lives at ../builders.json so a new
// builder is added without code change.

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	scrapeInterval = 3600 * time.Second // poll each builder hourly
	httpTimeout    = 30 * time.Second
)

func main() {
	fmt.Println("=== Hyperliquid Frontends Quality Harness ===")
	fmt.Println("OpenChainBench - builder-code effective fee + $/user + volume.")
	fmt.Println()

	registry, err := loadRegistry("./builders.json")
	if err != nil {
		fmt.Printf("[fatal] load registry: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Registry: %d builders\n", len(registry))
	for _, b := range registry {
		fmt.Printf("  · %-15s %s\n", b.Slug, b.Address)
	}
	fmt.Println()

	state, err := OpenState()
	if err != nil {
		fmt.Printf("[fatal] open state: %v\n", err)
		os.Exit(1)
	}
	defer state.Close()

	fmt.Println("Metrics server: :2112/metrics")
	fmt.Println()

	// Hardcoded :2112 per the OCB Railway scrape convention. We
	// deliberately ignore Railway's $PORT (would move the listener
	// away from where the shared Prom expects it). METRICS_ADDR is
	// a local-dev escape hatch only — never set in production.
	addr := os.Getenv("METRICS_ADDR")
	if addr == "" {
		addr = ":2112"
	}
	go func() {
		if err := StartMetricsServer(addr); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
			os.Exit(1)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// First cycle fires after a 5 s warmup so /metrics has data on the
	// first scrape; subsequent cycles run on the configured interval.
	warmup := time.NewTimer(5 * time.Second)
	defer warmup.Stop()
	ticker := time.NewTicker(scrapeInterval)
	defer ticker.Stop()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	for {
		select {
		case <-warmup.C:
			runCycle(ctx, registry, state)
		case <-ticker.C:
			runCycle(ctx, registry, state)
		case s := <-sig:
			fmt.Printf("\n[shutdown] received %v\n", s)
			cancel()
			return
		}
	}
}

func runCycle(ctx context.Context, registry []Builder, state *State) {
	cycleStart := time.Now()
	// Per-builder pass: fetch CSVs, update gauges, upsert into state.
	var totalNotional float64
	perBuilderNotional := make(map[string]float64, len(registry))
	for _, b := range registry {
		select {
		case <-ctx.Done():
			return
		default:
		}
		notional := processBuilder(ctx, b, state)
		perBuilderNotional[b.Slug] = notional
		totalNotional += notional
	}
	// Volume share + retention pass once state is up to date.
	for _, b := range registry {
		if totalNotional > 0 {
			hlVolumeSharePct.WithLabelValues(b.Slug).Set(perBuilderNotional[b.Slug] / totalNotional * 100)
		}
		for _, days := range []int{7, 30} {
			ret, cohort, err := state.Retention(ctx, b.Slug, days)
			if err != nil {
				fmt.Printf("[%s] retention(%dd) error: %v\n", b.Slug, days, err)
				continue
			}
			switch days {
			case 7:
				hlD7Retention.WithLabelValues(b.Slug).Set(ret)
				hlD7CohortSize.WithLabelValues(b.Slug).Set(float64(cohort))
			case 30:
				hlD30Retention.WithLabelValues(b.Slug).Set(ret)
				hlD30CohortSize.WithLabelValues(b.Slug).Set(float64(cohort))
			}
		}
	}
	// Prune anything past our 90-day horizon so the SQLite file stays
	// bounded. 90d > our longest retention window (D30) with 2x safety
	// margin for backfill / replay scenarios.
	if n, err := state.PruneOlderThan(90); err == nil && n > 0 {
		fmt.Printf("[state] pruned %d rows older than 90d\n", n)
	}
	fmt.Printf("[cycle] done in %s\n", time.Since(cycleStart).Round(time.Millisecond))
}
