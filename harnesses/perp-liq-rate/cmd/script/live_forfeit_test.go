//go:build live

package main

// live_forfeit_test.go: measure the forfeited-collateral shares off the real
// feeds, venue by venue, and print what carries them and what does not.
//
// Run with:
//
//	go test -tags live -v -timeout 900s -run TestLive_ForfeitedCollateral
//
// RPC_ARBITRUM and RPC_BASE want the keyed endpoints (the public Arbitrum RPC
// caps this filter near 3,125 blocks and a day's scan takes minutes on it).
// LIQ_LOOKBACK_HOURS widens the window past the 24h the harness publishes, for
// the venues whose 24h count is small: Ostium liquidates a handful of positions
// a week.

import (
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestLive_ForfeitedCollateral(t *testing.T) {
	hours := 24.0
	if v := os.Getenv("LIQ_LOOKBACK_HOURS"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			t.Fatalf("LIQ_LOOKBACK_HOURS: %v", err)
		}
		hours = f
	}
	sinceMs := time.Now().Add(-time.Duration(hours*3600) * time.Second).UnixMilli()

	rpcBase := os.Getenv("RPC_BASE")
	if rpcBase == "" {
		rpcBase = defaultRPCBase
	}
	rpcArb := os.Getenv("RPC_ARBITRUM")
	if rpcArb == "" {
		rpcArb = defaultRPCArbitrum
	}

	type venue struct {
		name   string
		assets []string
		source Source
	}
	venues := []venue{
		{"gains", []string{"ETH", "BTC"}, NewGainsMulti(NewGains(rpcBase), NewGainsArbitrum(rpcArb))},
		{"gmx", []string{"ETH", "BTC"}, NewGMX()},
		{"ostium", []string{"ETH", "BTC", "SOL"}, NewOstium()},
		{"hyperliquid", []string{"ETH", "BTC", "SOL"}, NewHyperliquid()},
		{"dydx", []string{"ETH", "BTC", "SOL"}, NewDydx()},
		{"paradex", []string{"ETH", "BTC"}, NewParadex()},
		{"orderly", []string{"ETH", "BTC", "SOL"}, NewOrderly()},
		{"lighter", []string{"ETH", "BTC"}, NewLighter()},
		{"aster", []string{"ETH", "BTC", "SOL"}, NewAster()},
		{"nado", []string{"ETH", "BTC"}, NewNado()},
	}

	fmt.Printf("\nwindow: the %.0f hours to %s UTC\n", hours, time.Now().UTC().Format(time.RFC3339))
	fmt.Printf("the venue-level columns cover closes between %.0fx and %.0fx only\n",
		comparableLeverageMin, comparableLeverageMax)
	fmt.Printf("%-12s %-5s %7s %7s %14s %14s %8s %8s %8s %8s %12s\n",
		"venue", "asset", "events", "in band", "notional", "collateral",
		"loss%", "return%", "forfeit", "fee%", "destroyed$")
	for _, v := range venues {
		for _, asset := range v.assets {
			if !v.source.HasLiquidationSource() {
				fmt.Printf("%-12s %-5s %7s\n", v.name, asset, "no feed")
				continue
			}
			evs, err := v.source.FetchLiquidationsSince(asset, sinceMs)
			if err != nil && len(evs) == 0 {
				fmt.Printf("%-12s %-5s %7s  %v\n", v.name, asset, "error", err)
				continue
			}
			w := NewSlidingWindow(time.Duration(hours*3600) * time.Second)
			notional := 0.0
			for _, e := range evs {
				if e.NotionalUSD <= 0 {
					continue
				}
				w.AddEvent(e)
				notional += e.NotionalUSD
			}
			col, _ := w.SumCollateral()
			st := w.ForfeitStats()
			forf, loss, ret, n := st.Forfeited, st.Loss, st.Returned, st.N
			if n == 0 {
				fmt.Printf("%-12s %-5s %7d %7s %14.0f %14s %8s %8s %8s\n",
					v.name, asset, w.Len(), "none", notional, "-", "-", "-", "-")
				continue
			}
			fee := "-"
			if st.HasFeeSplit {
				fee = fmt.Sprintf("%.2f", st.FeeAndCarry)
			}
			destroyed, _ := w.MarginDestroyedUSD()
			fmt.Printf("%-12s %-5s %7d %7d %14.0f %14.0f %8.1f %8.2f %8.1f %8s %12.0f\n",
				v.name, asset, w.Len(), n, notional, col, loss, ret, forf, fee, destroyed)
			bands := w.ForfeitByBand()
			names := make([]string, 0, len(bands))
			for _, b := range leverageBands {
				if bands[b.name].N > 0 {
					names = append(names, b.name)
				}
			}
			for _, name := range names {
				b := bands[name]
				fmt.Printf("%-12s %-5s   band %-9s n=%-5d loss %5.1f%%  forfeit %5.1f pts\n",
					"", "", name, b.N, b.Loss, b.Forfeited)
			}
			if closed, has, cErr := marginClosed24h(v.source, asset); cErr != nil {
				fmt.Printf("%-12s %-5s   margin closed: error %v\n", "", "", cErr)
			} else if has && closed > 0 {
				fmt.Printf("%-12s %-5s   margin destroyed $%.0f of $%.0f closed = %.2f%%\n",
					"", "", destroyed, closed, destroyed/closed*100)
			}
		}
	}
}
