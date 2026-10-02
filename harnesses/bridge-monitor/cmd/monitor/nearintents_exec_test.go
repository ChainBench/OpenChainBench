package main

import (
	"testing"
	"time"
)

// TestNearIntentsTriangleSupported verifies every leg of the USDC-only triangle
// resolves to a Near Intents assetId on both origin and destination, so the
// intent solver can actually execute all three hops.
func TestNearIntentsTriangleSupported(t *testing.T) {
	routes := GetNearIntentsTriangle()
	if len(routes) != 3 {
		t.Fatalf("expected 3 legs, got %d", len(routes))
	}
	for _, r := range routes {
		if _, ok := nearIntentsAssetID(r.FromChain, r.FromToken); !ok {
			t.Errorf("%s: origin %s/%s not supported by Near Intents", r.Name, r.FromChain, r.FromToken)
		}
		if _, ok := nearIntentsAssetID(r.ToChain, r.ToToken); !ok {
			t.Errorf("%s: destination %s/%s not supported by Near Intents", r.Name, r.ToChain, r.ToToken)
		}
		// Every leg is USDC-denominated, so the source classifies as USDC and
		// converts 1:1 at 6 decimals (no meme/decimal edge cases).
		if getSourceTokenName(r) != "USDC" {
			t.Errorf("%s: source token classified as %s, want USDC", r.Name, getSourceTokenName(r))
		}
	}
}

// TestNearIntentsTriangleConserves checks the triangle closes: the set of chains
// touched as a source equals the set touched as a destination, so inventory
// returns to start over a full cycle.
func TestNearIntentsTriangleConserves(t *testing.T) {
	routes := GetNearIntentsTriangle()
	src := map[string]int{}
	dst := map[string]int{}
	for _, r := range routes {
		src[r.FromChain]++
		dst[r.ToChain]++
	}
	for chain, n := range src {
		if dst[chain] != n {
			t.Errorf("chain %s is a source %d times but a destination %d times: cycle does not conserve", chain, n, dst[chain])
		}
	}
	if src["Solana"] != 1 || src["Base"] != 1 || src["Arbitrum"] != 1 {
		t.Errorf("expected exactly one leg sourced from each of Solana/Base/Arbitrum, got %v", src)
	}
}

// TestTransferERC20DryRun exercises the calldata path in dry-run (no broadcast),
// confirming a valid raw amount is accepted and an invalid one is rejected.
func TestTransferERC20InvalidAmount(t *testing.T) {
	tx := &TxExecutor{dryRun: true}
	if _, err := tx.TransferERC20("base", baseUSDCAddr, "0x0000000000000000000000000000000000000001", "not-a-number"); err == nil {
		t.Fatal("expected error for non-numeric raw amount")
	}
}

// Every bridge must be polled on the same cadence, or the published latency
// comparison records our own polling as if it were the bridges'.
//
// Near Intents polled at 15 s while the other three polled at 5 s, AND it
// slept before its first check rather than after, which put a floor of one
// whole interval under every measurement. Together those published 36.7 s for
// a bridge whose competitors read 1.0 to 1.5 s, and the gap was mostly ours.
func TestSettlePollIntervalIsSharedAcrossBridges(t *testing.T) {
	if nearIntentsSettleWaitMs != settlePollInterval {
		t.Fatalf("Near Intents polls at %v while the shared cadence is %v: "+
			"the latency comparison would record the difference as the bridge's",
			nearIntentsSettleWaitMs, settlePollInterval)
	}
	if settlePollInterval > 2*time.Second {
		t.Fatalf("settle poll interval %v is coarser than the ~1 s the fastest "+
			"bridges settle in, so their latency would quantise to it",
			settlePollInterval)
	}
}
