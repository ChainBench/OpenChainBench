package main

import (
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
)

func main() {
	installLogCapture()
	fmt.Println("=== Tokenized Stock Peg Harness ===")
	fmt.Println("OpenChainBench — Robinhood Chain tokenized equities vs Nasdaq reference.")
	fmt.Printf("Cohort: %d assets | poll: %s | RPC: %s\n", len(assets), pollInterval, rpcURL())
	for _, a := range assets {
		fmt.Printf("  - %-6s token=%s pool=%s… fee=%.2f%%\n", a.Symbol, a.Token[:10]+"…", a.PoolID[:14], float64(a.FeePPM)/10000)
	}

	go func() {
		if err := startMetricsServer(listenAddr()); err != nil {
			fmt.Printf("[fatal] metrics server: %v\n", err)
		}
	}()

	client := &http.Client{Timeout: httpTimeout}
	var periods *tradingPeriods
	var prevState string
	tracker := newArbTracker()

	tick := func() {
		now := time.Now()
		if periods == nil || now.Sub(periods.FetchedAt) > 30*time.Minute {
			if tp := fetchTradingPeriods(client); tp != nil {
				periods = tp
			}
		}
		state := periods.state(now)
		if prevState == "regular" && state != "regular" {
			tracker.closeStaleOnStateChange("robinhood")
		}
		prevState = state
		for _, s := range []string{"pre", "regular", "post", "closed", "unknown"} {
			v := 0.0
			if s == state {
				v = 1.0
			}
			tspMarketState.WithLabelValues(s).Set(v)
		}

		refs := fetchReferencePrices(client)
		onchain := fetchOnchainPrices(client)

		for _, a := range assets {
			sym := strings.ToLower(a.Symbol)
			ref, hasRef := refs[sym]
			pool, hasPool := onchain[sym]
			if hasRef {
				tspPriceReference.WithLabelValues(sym).Set(ref.Price)
				if ref.AsOfSec > 0 {
					tspRefAge.WithLabelValues(sym).Set(float64(now.Unix() - ref.AsOfSec))
				}
			}
			if hasPool {
				tspPriceOnchain.WithLabelValues(sym, "robinhood").Set(pool)
			}
			if hasRef && hasPool && ref.Price > 0 {
				dev := math.Abs(pool-ref.Price) / ref.Price * 10000
				tspDeviationBps.WithLabelValues(sym, state, "robinhood").Set(dev)
				if state == "regular" {
					tracker.observe(sym, "robinhood", now, ref.Price, pool)
				}
				tspHealth.WithLabelValues(sym).Set(1)
				flag := ""
				if dev > logThresholdBps && state == "regular" {
					flag = "  <-- wide"
				}
				fmt.Printf("[%s][%s] pool=%.2f ref=%.2f dev=%.1fbps%s\n", sym, state, pool, ref.Price, dev, flag)
			} else {
				tspHealth.WithLabelValues(sym).Set(0)
			}
		}
	}

	tick()
	t := time.NewTicker(pollInterval)
	defer t.Stop()
	for range t.C {
		tick()
	}
}
