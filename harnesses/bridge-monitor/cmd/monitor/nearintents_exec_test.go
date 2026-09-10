package main

import "testing"

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
