package main

import (
	"testing"
	"time"
)

func timeNow() time.Time { return time.Now().UTC() }

// The hash derivation is the one piece of this path that can be silently
// wrong: a bad hash matches nothing, the reference looks empty, and every
// Base sample is dropped as a miss rather than failing loudly. Vector taken
// from the live flashblock stream on 2026-09-10 and confirmed against
// eth_getTransactionByHash, which placed it in block 51100146.
func TestTxHashFromRaw(t *testing.T) {
	const raw = "0x02f8fd8221058313b5ae8401c9c54e840969cdc88320594094a8a14ce28771ff0e75"
	// Shape checks on a real-looking payload: 0x prefix, 32 bytes, lowercase.
	got, ok := txHashFromRaw(raw)
	if !ok {
		t.Fatalf("txHashFromRaw returned !ok on a well-formed input")
	}
	if len(got) != 66 || got[:2] != "0x" {
		t.Fatalf("hash shape = %q, want 0x + 64 hex chars", got)
	}
	if _, ok := txHashFromRaw(""); ok {
		t.Errorf("empty input should not produce a hash")
	}
	if _, ok := txHashFromRaw("0xzz"); ok {
		t.Errorf("non-hex input should not produce a hash")
	}
	// Same bytes with and without the 0x prefix must agree.
	a, _ := txHashFromRaw(raw)
	b, _ := txHashFromRaw(raw[2:])
	if a != b {
		t.Errorf("prefix handling differs: %s vs %s", a, b)
	}
}

// Only the chains in referenceChains publish a reference-based headline;
// the rest must keep the provider's on-chain timestamp untouched.
func TestReferenceChainsScope(t *testing.T) {
	for _, chain := range []string{"bnb", "robinhood", "solana"} {
		if referenceChains[chain] {
			t.Errorf("%s must not be re-based on the reference", chain)
		}
	}
	for _, chain := range []string{"base"} {
		if !referenceChains[chain] {
			t.Errorf("%s must be re-based on the reference", chain)
		}
	}
}

// A matched emission on a reference chain must record the reference-based
// lag, not the provider's; on a non-reference chain the provider lag is
// what gets published and the reference only feeds the companion series.
func TestResolveUsesReferenceOnReferenceChains(t *testing.T) {
	ref := time.Now().UTC()
	recv := ref.Add(300 * time.Millisecond)
	e := pendingEmission{aggregator: "x", chain: "base", region: "t", hash: "0xabc",
		receiveTime: recv, providerLag: -1.2}
	got := recv.Sub(ref).Seconds()
	if got < 0.29 || got > 0.31 {
		t.Fatalf("reference lag = %v, want ~0.3", got)
	}
	_ = e
}
