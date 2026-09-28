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
		fmt.Printf("scanned blocks %d..%d\n", f, tb)
	} else {
		// One hour of Arbitrum at the measured 267 ms per block.
		g.lookbackBlocks = 13500
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
	fmt.Println("top pairs by notional:")
	for i, p := range pairs {
		if i >= 10 {
			break
		}
		fmt.Printf("  pair %3d: $%12.0f  %4d legs  %5.1f%% of the window\n",
			p, byPair[p], cntPair[p], byPair[p]/all*100)
	}

	// Every leg of ETH, with the checks that matter.
	seenKey := map[string]int{}
	seenTxPairNotional := map[string]int{}
	byKind := map[gainsExecKind]float64{}
	kindCount := map[gainsExecKind]int{}
	var ethTotal float64
	fmt.Println("\nETH (pair 1) legs:")
	for _, e := range g.execs {
		if e.pair != 1 {
			continue
		}
		ethTotal += e.notionalUSD
		byKind[e.kind] += e.notionalUSD
		kindCount[e.kind]++
		seenKey[e.key]++
		seenTxPairNotional[fmt.Sprintf("%s:%.4f", e.key[:66], e.notionalUSD)]++
		fmt.Printf("  %-8s $%12.2f  %s\n", e.kind, e.notionalUSD, e.key)
	}
	fmt.Printf("\nETH total in the window: $%.0f over %d legs\n", ethTotal, kindCount[gainsKindMarket]+kindCount[gainsKindLimit]+kindCount[gainsKindIncrease]+kindCount[gainsKindDecrease])
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
	fmt.Printf("\nextrapolated 24h (only meaningful for an hour window): $%.0f ETH, $%.0f all pairs\n", ethTotal*24, all*24)
}
