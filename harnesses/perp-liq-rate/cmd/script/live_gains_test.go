//go:build live

package main

import (
	"fmt"
	"os"
	"testing"
	"time"
)

// Run with:
//
//	RPC_ARBITRUM=... go test -tags live -v -timeout 900s -run TestLive_GainsVolume ./cmd/script
//
// Scans both deployments once (a day of Arbitrum in 5k-block windows takes
// a few minutes on a public RPC), prints per-asset traded notional and
// liquidations, and the venue-level total next to the Gains backend's
// volume-mix for the trailing day, which is the figure bench 266 publishes.
func TestLive_GainsVolume(t *testing.T) {
	arb := os.Getenv("RPC_ARBITRUM")
	if arb == "" {
		arb = defaultRPCArbitrum
	}
	base := os.Getenv("RPC_BASE")
	if base == "" {
		base = defaultRPCBase
	}
	chains := []*Gains{NewGainsArbitrum(arb), NewGains(base)}
	start := time.Now()
	for _, g := range chains {
		if err := g.scan(); err != nil {
			t.Fatalf("%s scan: %v", g.chain, err)
		}
		g.mu.Lock()
		byKind := map[gainsExecKind]int{}
		byPair := map[uint64]float64{}
		var liq float64
		for _, e := range g.execs {
			byKind[e.kind]++
			byPair[e.pair] += e.notionalUSD
			if e.liquidation {
				liq += e.notionalUSD
			}
		}
		var venue float64
		for _, v := range byPair {
			venue += v
		}
		fmt.Printf("[%s] cursor=%d legs=%d kinds=%v pairs=%d\n", g.chain, g.cursor, len(g.execs), byKind, len(byPair))
		fmt.Printf("[%s] buffer (26h) notional all pairs=$%.0f  BTC=$%.0f  ETH=$%.0f  liquidations=$%.0f\n",
			g.chain, venue, byPair[0], byPair[1], liq)
		g.mu.Unlock()
	}
	fmt.Printf("scan took %s\n", time.Since(start).Round(time.Second))

	m := NewGainsMulti(chains...)
	var total24 float64
	for _, asset := range []string{"BTC", "ETH"} {
		v, err := m.FetchVolume24hUSD(asset)
		if err != nil {
			t.Fatalf("volume %s: %v", asset, err)
		}
		evs, err := m.FetchLiquidationsSince(asset, 0)
		if err != nil {
			t.Fatalf("liq %s: %v", asset, err)
		}
		var liq float64
		cut := time.Now().Add(-24 * time.Hour).UnixMilli()
		for _, e := range evs {
			if e.TimestampMs >= cut {
				liq += e.NotionalUSD
			}
		}
		fmt.Printf("%s: volume24h=$%.0f liquidated24h=$%.0f share=%.3f%%\n", asset, v, liq, liq/v*100)
		total24 += v
	}

	// Venue-level 24h across every pair, for the comparison with the
	// backend's trade perimeter (opens and closes at full notional, resizes
	// at their traded delta; auto + direct).
	cut := time.Now().Add(-24 * time.Hour).UnixMilli()
	var allPairs float64
	for _, g := range chains {
		g.mu.Lock()
		for _, e := range g.execs {
			if e.tsMs >= cut {
				allPairs += e.notionalUSD
			}
		}
		g.mu.Unlock()
	}
	// Same-window comparison: the backend reports whole UTC days, so the
	// on-chain sum since UTC midnight is set against the backend's figure
	// for today alone.
	midnight := time.Now().UTC().Truncate(24 * time.Hour).UnixMilli()
	var sinceMidnight float64
	for _, g := range chains {
		g.mu.Lock()
		for _, e := range g.execs {
			if e.tsMs >= midnight {
				sinceMidnight += e.notionalUSD
			}
		}
		g.mu.Unlock()
	}
	today := time.Now().UTC().Format("2006-01-02")
	var mix struct {
		Auto   float64 `json:"autoVolumeUsd"`
		Direct float64 `json:"directVolumeUsd"`
		Total  float64 `json:"totalVolumeUsd"`
		Traded float64 `json:"totalTradedVolumeUsd"`
		Last   int64   `json:"lastTradeTimestamp"`
	}
	u := fmt.Sprintf("https://backend-global.gains.trade/api/volume-mix?from=%s&to=%s", today, today)
	if err := httpGetJSON(u, &mix); err != nil {
		t.Logf("volume-mix: %v", err)
	} else {
		fmt.Printf("on-chain 24h all pairs (Arbitrum+Base)=$%.0f  BTC+ETH=$%.0f\n", allPairs, total24)
		fmt.Printf("on-chain since UTC midnight all pairs=$%.0f (%.1fh)\n", sinceMidnight, float64(time.Now().UnixMilli()-midnight)/3.6e6)
		fmt.Printf("backend volume-mix %s (all chains, last trade %s): auto+direct=$%.0f  totalTraded=$%.0f  total=$%.0f  gap=%.1f%%\n",
			today, time.Unix(mix.Last, 0).UTC().Format(time.RFC3339), mix.Auto+mix.Direct, mix.Traded, mix.Total,
			(sinceMidnight-(mix.Auto+mix.Direct))/(mix.Auto+mix.Direct)*100)
	}
}
