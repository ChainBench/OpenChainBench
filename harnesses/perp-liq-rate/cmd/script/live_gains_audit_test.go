//go:build live

package main

// live_gains_audit_test.go: the traded-notional sum, audited leg by leg.
//
//	RPC_ARBITRUM=... go test -tags live -v -timeout 900s -run TestLive_GainsVolumeAudit ./cmd/script
//
// Scans one hour of the Arbitrum diamond, groups the legs by pair, and for
// ETH prints every leg it is summing with its transaction, event kind and
// notional, so a reader can confirm each is a distinct trade on pair 1
// counted once. It also looks for the two ways a sum like this goes wrong:
// the same log counted twice, and two logs of the same transaction carrying
// the same pair and notional, which is what a duplicated event per trade
// would look like.

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"
)

func TestLive_GainsVolumeAudit(t *testing.T) {
	arb := os.Getenv("RPC_ARBITRUM")
	if arb == "" {
		arb = defaultRPCArbitrum
	}
	g := NewGainsArbitrum(arb)
	if os.Getenv("GAINS_CHAIN") == "base" {
		base := os.Getenv("RPC_BASE")
		if base == "" {
			base = defaultRPCBase
		}
		g = NewGains(base)
	}
	// A fixed block range when given, so a complete UTC day can be set
	// against the Gains backend's figure for that same day; otherwise one
	// hour up to the chain head.
	if from, to := os.Getenv("GAINS_FROM_BLOCK"), os.Getenv("GAINS_TO_BLOCK"); from != "" && to != "" {
		f, err := strconv.ParseUint(from, 10, 64)
		if err != nil {
			t.Fatalf("GAINS_FROM_BLOCK: %v", err)
		}
		tb, err := strconv.ParseUint(to, 10, 64)
		if err != nil {
			t.Fatalf("GAINS_TO_BLOCK: %v", err)
		}
		if err := g.scanRange(f, tb); err != nil {
			t.Fatalf("scanRange: %v", err)
		}
		// The range is only a complete day if its ends say so, and the
		// nominal block time cannot be assumed: 267 ms was measured on one
		// day, and this range implies 280.7 ms. Read both headers and print
		// them, so the window the figures describe is on the record.
		fromMs, err := g.blockTimestampMs(f)
		if err != nil {
			t.Fatalf("from header: %v", err)
		}
		toMs, err := g.blockTimestampMs(tb)
		if err != nil {
			t.Fatalf("to header: %v", err)
		}
		fmt.Printf("scanned blocks %d..%d (%d blocks)\n", f, tb, tb-f+1)
		fmt.Printf("window: %s .. %s (%.2f h, %.1f ms/block)\n",
			time.UnixMilli(fromMs).UTC().Format(time.RFC3339),
			time.UnixMilli(toMs).UTC().Format(time.RFC3339),
			float64(toMs-fromMs)/3.6e6, float64(toMs-fromMs)/float64(tb-f))
	} else {
		// One hour up to the chain head: Arbitrum at the measured 267 ms a
		// block, Base at 2 s, or the extrapolation below covers 7.5 hours on
		// Base and calls it an hour.
		g.lookbackBlocks = 13500
		if g.chain == "base" {
			g.lookbackBlocks = 1800
		}
		if err := g.scan(); err != nil {
			t.Fatalf("scan: %v", err)
		}
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	fmt.Printf("legs in the window: %d\n", len(g.execs))

	byPair := map[uint64]float64{}
	cntPair := map[uint64]int{}
	for _, e := range g.execs {
		byPair[e.pair] += e.notionalUSD
		cntPair[e.pair]++
	}
	pairs := make([]uint64, 0, len(byPair))
	for p := range byPair {
		pairs = append(pairs, p)
	}
	sort.Slice(pairs, func(i, j int) bool { return byPair[pairs[i]] > byPair[pairs[j]] })
	var all float64
	for _, v := range byPair {
		all += v
	}
	fmt.Printf("all pairs in the window: $%.0f across %d pairs\n", all, len(byPair))
	fmt.Println("every pair by notional:")
	for _, p := range pairs {
		fmt.Printf("  pair %3d: $%12.0f  %4d legs  %5.2f%% of the window\n",
			p, byPair[p], cntPair[p], byPair[p]/all*100)
	}

	// The duplicate check covers every leg in the window, not just the asset
	// printed below: a BTC log present twice would be summed twice into the
	// venue total, and a check scoped to ETH would pass anyway.
	seenKey := map[string]int{}
	seenTxPairNotional := map[string]int{}
	for _, e := range g.execs {
		seenKey[e.key]++
		seenTxPairNotional[fmt.Sprintf("%s:%d:%.4f", e.key[:66], e.pair, e.notionalUSD)]++
	}

	// Every leg of one asset, printed so each can be read back against the
	// chain. ETH by default; GAINS_AUDIT_PAIR picks another.
	auditPair := uint64(1)
	if v := os.Getenv("GAINS_AUDIT_PAIR"); v != "" {
		p, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			t.Fatalf("GAINS_AUDIT_PAIR: %v", err)
		}
		auditPair = p
	}
	byKind := map[gainsExecKind]float64{}
	kindCount := map[gainsExecKind]int{}
	var ethTotal float64
	fmt.Printf("\npair %d legs:\n", auditPair)
	for _, e := range g.execs {
		if e.pair != auditPair {
			continue
		}
		ethTotal += e.notionalUSD
		byKind[e.kind] += e.notionalUSD
		kindCount[e.kind]++
		fmt.Printf("  %-8s $%12.2f  %s\n", e.kind, e.notionalUSD, e.key)
	}
	fmt.Printf("\npair %d total in the window: $%.0f over %d legs\n", auditPair, ethTotal, kindCount[gainsKindMarket]+kindCount[gainsKindLimit]+kindCount[gainsKindIncrease]+kindCount[gainsKindDecrease])
	for _, k := range []gainsExecKind{gainsKindMarket, gainsKindLimit, gainsKindIncrease, gainsKindDecrease} {
		fmt.Printf("  %-9s %4d legs  $%12.0f\n", k, kindCount[k], byKind[k])
	}

	dupKeys := 0
	for k, n := range seenKey {
		if n > 1 {
			dupKeys++
			fmt.Printf("DUPLICATE KEY counted %d times: %s\n", n, k)
		}
	}
	if dupKeys > 0 {
		t.Fatalf("%d log keys counted more than once", dupKeys)
	}
	for k, n := range seenTxPairNotional {
		if n > 1 {
			fmt.Printf("same tx, same notional, %d legs (a round trip in one tx, or a duplicated event): %s\n", n, k)
		}
	}
	fmt.Printf("\nextrapolated 24h (only meaningful for an hour window): $%.0f pair %d, $%.0f all pairs\n", ethTotal*24, auditPair, all*24)
}

// The GMX volume denominator must be a positive figure against the live
// squid. It silently read zero for a while because marketAddress_in was sent
// in the wrong case, and nothing failed: the gauge simply stopped being
// published and both GMX rows lost their rank.
func TestLive_GMXVolumeIsPositive(t *testing.T) {
	g := NewGMX()
	for _, asset := range []string{"ETH", "BTC"} {
		vol, err := g.FetchVolume24hUSD(asset)
		if err != nil {
			t.Fatalf("%s volume: %v", asset, err)
		}
		if vol <= 0 {
			t.Fatalf("%s volume = %v against the live squid", asset, vol)
		}
		fmt.Printf("gmx %s 24h traded notional: $%.0f\n", asset, vol)
	}
}
