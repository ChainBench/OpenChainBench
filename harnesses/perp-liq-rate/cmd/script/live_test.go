//go:build live

package main

import (
	"fmt"
	"testing"
	"time"
)

// Run with: go test -tags live -v -timeout 120s -run TestLive

func TestLive_AllVenuesOI(t *testing.T) {
	type result struct {
		venue string
		asset string
		oi    float64
		err   error
	}

	type venueSource struct {
		name   string
		source Source
	}

	sources := []venueSource{
		{"hyperliquid", NewHyperliquid()},
		{"dydx", NewDydx()},
		{"gmx", NewGMX()},
		{"lighter", NewLighter()},
		{"gains", NewGains("https://mainnet.base.org")},
		{"aevo", NewAevo()},
		{"paradex", NewParadex()},
	}
	assets := []string{"ETH", "BTC"}

	results := make([]result, 0, len(sources)*len(assets))
	for _, vs := range sources {
		for _, asset := range assets {
			oi, err := vs.source.FetchOI(asset)
			results = append(results, result{vs.name, asset, oi, err})
		}
	}

	fmt.Println("\n=== OI Results (USD) ===")
	fmt.Printf("%-15s %-5s %20s  %s\n", "VENUE", "ASSET", "OI_USD", "STATUS")
	fmt.Println("-------------------------------------------------------------")
	for _, r := range results {
		if r.err != nil {
			fmt.Printf("%-15s %-5s %20s  ERROR: %v\n", r.venue, r.asset, "-", r.err)
		} else {
			fmt.Printf("%-15s %-5s %20.2f  OK\n", r.venue, r.asset, r.oi)
		}
	}
}

func TestLive_AllVenuesLiquidations(t *testing.T) {
	type result struct {
		venue  string
		asset  string
		count  int
		volume float64
		err    error
	}

	type venueSource struct {
		name   string
		source Source
	}

	sinceMs := time.Now().Add(-24 * time.Hour).UnixMilli()

	sources := []venueSource{
		{"hyperliquid", NewHyperliquid()},
		{"dydx", NewDydx()},
		{"gmx", NewGMX()},
		{"lighter", NewLighter()},
		{"gains", NewGains("https://mainnet.base.org")},
		{"aevo", NewAevo()},
		{"paradex", NewParadex()},
	}
	assets := []string{"ETH", "BTC"}

	results := make([]result, 0, len(sources)*len(assets))
	for _, vs := range sources {
		for _, asset := range assets {
			events, err := vs.source.FetchLiquidationsSince(asset, sinceMs)
			vol := 0.0
			for _, e := range events {
				vol += e.NotionalUSD
			}
			results = append(results, result{vs.name, asset, len(events), vol, err})
		}
	}

	fmt.Println("\n=== Liquidations (last 24h, first tick only) ===")
	fmt.Printf("%-15s %-5s %8s %20s  %s\n", "VENUE", "ASSET", "COUNT", "VOLUME_USD", "STATUS")
	fmt.Println("-----------------------------------------------------------------------")
	for _, r := range results {
		if r.err != nil {
			fmt.Printf("%-15s %-5s %8s %20s  ERROR: %v\n", r.venue, r.asset, "-", "-", r.err)
		} else {
			fmt.Printf("%-15s %-5s %8d %20.2f  OK\n", r.venue, r.asset, r.count, r.volume)
		}
	}
}

func TestLive_LighterEndpoints(t *testing.T) {
	l := NewLighter()

	fmt.Println("\n=== Lighter: orderBookDetails ===")
	markets, err := l.fetchMarkets()
	if err != nil {
		t.Fatalf("fetchMarkets: %v", err)
	}
	for _, m := range markets {
		fmt.Printf("  symbol=%-12s market_id=%d  OI=%.4f  mark_price=%.4f  OI_USD=%.2f\n",
			m.Symbol, m.MarketID, m.OpenInterest, float64(m.MarkPrice),
			m.OpenInterest*float64(m.MarkPrice))
	}

	fmt.Println("\n=== Lighter: ETH liquidations (last 1h) ===")
	sinceMs := time.Now().Add(-1 * time.Hour).UnixMilli()
	events, err := l.FetchLiquidationsSince("ETH", sinceMs)
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
	} else {
		fmt.Printf("  %d events in last 1h\n", len(events))
		for i, e := range events {
			if i >= 5 {
				fmt.Printf("  ... and %d more\n", len(events)-5)
				break
			}
			fmt.Printf("  key=%s  notional=%.2f  ts=%d\n", e.Key, e.NotionalUSD, e.TimestampMs)
		}
	}
}

func TestLive_ParadexEndpoints(t *testing.T) {
	p := NewParadex()

	fmt.Println("\n=== Paradex: ETH OI ===")
	oi, err := p.FetchOI("ETH")
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
	} else {
		fmt.Printf("  OI = %.2f\n", oi)
	}

	fmt.Println("\n=== Paradex: ETH liquidations (last 1h) ===")
	sinceMs := time.Now().Add(-1 * time.Hour).UnixMilli()
	events, err := p.FetchLiquidationsSince("ETH", sinceMs)
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
	} else {
		fmt.Printf("  %d events in last 1h\n", len(events))
		for i, e := range events {
			if i >= 5 {
				fmt.Printf("  ... and %d more\n", len(events)-5)
				break
			}
			fmt.Printf("  key=%s  notional=%.2f  ts=%d\n", e.Key, e.NotionalUSD, e.TimestampMs)
		}
	}
}

func TestLive_HyperliquidRecentTrades(t *testing.T) {
	h := NewHyperliquid()
	fmt.Println("\n=== Hyperliquid: recentTrades ETH (liquidation field check) ===")
	sinceMs := time.Now().Add(-1 * time.Hour).UnixMilli()
	events, err := h.FetchLiquidationsSince("ETH", sinceMs)
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
		return
	}
	fmt.Printf("  %d liquidation events in last 1h from recentTrades\n", len(events))
	if len(events) == 0 {
		fmt.Println("  NOTE: recentTrades may not carry a liquidation flag — field always absent/null")
	}

	fmt.Println("\n=== Hyperliquid: ETH OI ===")
	oi, err := h.FetchOI("ETH")
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
	} else {
		fmt.Printf("  OI = %.2f USD\n", oi)
	}
}

func TestLive_DydxSanity(t *testing.T) {
	d := NewDydx()
	fmt.Println("\n=== dYdX: ETH liquidations (last 24h) ===")
	sinceMs := time.Now().Add(-24 * time.Hour).UnixMilli()
	events, err := d.FetchLiquidationsSince("ETH", sinceMs)
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
		return
	}
	vol := 0.0
	for _, e := range events {
		vol += e.NotionalUSD
	}
	fmt.Printf("  %d events, volume=%.2f USD\n", len(events), vol)
	oi, err := d.FetchOI("ETH")
	if err != nil {
		fmt.Printf("  OI ERROR: %v\n", err)
	} else {
		if oi > 0 && vol > 0 {
			fmt.Printf("  OI=%.2f  liq_rate=%.4f%%\n", oi, vol/oi*100)
		} else {
			fmt.Printf("  OI=%.2f  (no liquidations yet in window)\n", oi)
		}
	}
}
