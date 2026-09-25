// protocol-valuation ranks every token whose protocol earns real fees on
// price-to-fees, alongside its float and its position against its own
// category.
//
// It is the market-wide cousin of bench 265 (perp-pf-ratio), which ranks
// twenty perp DEXes from a registry written by hand. The registry exists
// because a fee adapter is per product and the token belongs to the parent
// protocol, and the parent has no row in DeFiLlama's /protocols at all.
// /config carries those 849 parents with their CoinGecko ids, which turns
// a hand-curated list of twenty into a join that resolves about 190.
//
//	─── Gauges exposed ───────────────────────────────────────────────
//	protocol_pf_ratio{protocol}              — mcap / annualized fees
//	protocol_pf_fdv_ratio{protocol}          — FDV / annualized fees
//	protocol_float_pct{protocol}             — circulating / total supply
//	protocol_fees_30d_usd{protocol,category} — summed across adapters
//	protocol_fee_growth_30d_pct{protocol}    — month over month
//	protocol_price_change_30d_pct{protocol}  — the other side of the trend
//	protocol_category_pf_median{category}    — the peer yardstick
//	protocol_pf_vs_category_ratio{protocol}  — below 1 is cheap vs peers
//	protocol_diverging{protocol}             — the screen, 1 or 0
//	protocol_revenue_30d_usd{protocol,category}  — what the protocol keeps
//	protocol_ps_ratio{protocol,category}     — mcap / annualized revenue
//	protocol_tvl_usd{protocol,category}      — DeFiLlama TVL, parent scope
//	protocol_supply_change_30d_pct / _90d_pct{protocol,category}
//	                                         — realized dilution
//
// Cadence is hourly: DeFiLlama's fee series is daily and CoinGecko's free
// tier is rate-limited, so a faster tick would spend requests to re-read
// numbers that have not moved. The supply series costs one CoinGecko call
// per token per UTC day, cached in memory (supply.go).
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
	fmt.Println("=== protocol-valuation harness ===")
	fmt.Println("P/F, FDV/F, float and the peer comparison for every token whose protocol earns fees.")
	cfg := loadConfig()
	fmt.Printf("Exposes /metrics on %s.\n", cfg.MetricsAddr)
	supply := newSupplyCache()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := StartMetricsServer(cfg.MetricsAddr); err != nil {
			fmt.Printf("metrics server error: %v\n", err)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		tick := time.NewTicker(cfg.RefreshInterval)
		defer tick.Stop()
		poll(cfg, supply)
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				poll(cfg, supply)
			}
		}
	}()

	<-sigChan
	fmt.Println("\nshutting down...")
	close(stop)
	wg.Wait()
}

func poll(cfg *Config, supply *supplyCache) {
	start := time.Now()

	cohort, st, err := buildCohort(cfg.MinFees30dUSD)
	if err != nil {
		pvFetchErrors.WithLabelValues("defillama").Inc()
		fmt.Printf("[cohort] error: %v\n", err)
		return
	}

	ids := make([]string, 0, len(cohort))
	for _, p := range cohort {
		ids = append(ids, p.GeckoID)
	}
	markets, err := fetchMarkets(ids)
	if err != nil {
		pvFetchErrors.WithLabelValues("coingecko").Inc()
		fmt.Printf("[markets] error: %v\n", err)
		// A partial page still publishes: losing the tail of the cohort is
		// better than losing the board, and the cohort-size gauge says how
		// many rows survived.
		if len(markets) == 0 {
			return
		}
	}

	rows := buildRows(cohort, markets, cfg.MinFloatPct)
	medians := CategoryMedians(rows)
	sizes := map[string]int{}
	for _, r := range rows {
		if r.HasPF {
			sizes[r.Category]++
		}
	}
	publish(rows, medians, sizes, st, float64(time.Now().Unix()))

	diverging, withPS, withTVL := 0, 0, 0
	for _, r := range rows {
		if r.Diverging() {
			diverging++
		}
		if r.HasPS {
			withPS++
		}
		if r.HasTVL {
			withTVL++
		}
	}
	fmt.Printf("[poll] %d adapters -> %d tokens (%d via parent, %d merged, %d unmapped, %d below floor) -> %d rows, %d incomplete, %d peer groups, %d diverging, %d with P/S, %d with TVL, %v\n",
		st.Adapters, st.Mapped, st.ViaParent, st.Merged, st.Unmapped, st.BelowFloor,
		len(rows), st.Incomplete, len(medians), diverging, withPS, withTVL, time.Since(start).Round(time.Millisecond))

	// The supply series is the slow read: on the first tick of a UTC day it
	// is one paced CoinGecko call per row, some minutes for the cohort.
	// The board above is already published, so a restart does not hold
	// every gauge behind it; the rows are republished once it is attached.
	now := time.Now()
	fetched := attachSupplyChange(rows, supply, now)
	pvSupplyCacheSize.Set(float64(supply.size()))
	publish(rows, medians, sizes, st, float64(time.Now().Unix()))
	withSupply30, withSupply90 := 0, 0
	for _, r := range rows {
		if r.HasSupply30d {
			withSupply30++
		}
		if r.HasSupply90d {
			withSupply90++
		}
	}
	fmt.Printf("[supply] fetched %d series, %d cached for %s, %d/%d rows with supply 30d/90d, %v\n",
		fetched, supply.size(), now.UTC().Format("2006-01-02"), withSupply30, withSupply90, time.Since(now).Round(time.Millisecond))
}
