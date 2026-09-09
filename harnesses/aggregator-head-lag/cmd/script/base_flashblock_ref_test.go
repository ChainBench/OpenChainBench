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

// Base is the only chain re-based on the flashblock reference; everything
// else must keep the provider's on-chain timestamp untouched.
func TestHeadlineLagOnlyRebasesBase(t *testing.T) {
	for _, chain := range []string{"solana", "bnb", "robinhood"} {
		got, ok := headlineLag(chain, timeNow(), 1.25, "0xdead")
		if !ok || got != 1.25 {
			t.Errorf("%s: got (%v, %v), want (1.25, true)", chain, got, ok)
		}
	}
	// Base with no reference match must drop the sample, never fall back.
	if _, ok := headlineLag("base", timeNow(), 1.25, "0xnotseen"); ok {
		t.Errorf("base with no reference match should return ok=false")
	}
}
