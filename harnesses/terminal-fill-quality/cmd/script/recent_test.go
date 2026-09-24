package main

import (
	"testing"
)

// mkSwaps builds `n` swaps for one terminal, oldest first, with strictly
// increasing timestamps offset by `base` so the ordering of the merged
// result is checkable.
func mkSwaps(terminal string, n int, base int64) []Swap {
	out := make([]Swap, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, Swap{Terminal: terminal, Sig: terminal, Time: base + int64(i)})
	}
	return out
}

// The table under the board is its evidence, so every row that publishes
// a figure must appear in it. The global tail this replaced gave the
// busiest terminals everything and six ranked rows nothing at all.
func TestRecentCoversEveryTerminal(t *testing.T) {
	st := &State{}
	// One firehose and three quiet terminals, interleaved so a tail of
	// the flat slice would be almost entirely the firehose.
	st.Swaps = append(st.Swaps, mkSwaps("busy", 2000, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("quiet-a", 3, 5000)...)
	st.Swaps = append(st.Swaps, mkSwaps("quiet-b", 1, 6000)...)
	st.Swaps = append(st.Swaps, mkSwaps("quiet-c", 40, 7000)...)

	got := recent(st, 15, 900)

	seen := map[string]int{}
	for _, s := range got {
		seen[s.Terminal]++
	}
	for _, want := range []string{"busy", "quiet-a", "quiet-b", "quiet-c"} {
		if seen[want] == 0 {
			t.Fatalf("terminal %q has no rows in the sample: %v", want, seen)
		}
	}
	if seen["quiet-a"] != 3 {
		t.Fatalf("quiet-a has 3 swaps in the window, sample kept %d", seen["quiet-a"])
	}
	if seen["quiet-b"] != 1 {
		t.Fatalf("quiet-b has 1 swap in the window, sample kept %d", seen["quiet-b"])
	}
	if seen["busy"] > 15 {
		t.Fatalf("per-terminal cap is 15, busy kept %d", seen["busy"])
	}
}

// The ceiling is a payload guard, and it must not reintroduce the bug it
// replaced by spending itself on whoever is loudest.
func TestRecentTotalCeilingLeavesNobodyOut(t *testing.T) {
	st := &State{}
	for _, slug := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		st.Swaps = append(st.Swaps, mkSwaps(slug, 50, 0)...)
	}
	const total = 20
	got := recent(st, 15, total)
	if len(got) > total {
		t.Fatalf("sample of %d exceeds the ceiling of %d", len(got), total)
	}
	seen := map[string]int{}
	for _, s := range got {
		seen[s.Terminal]++
	}
	if len(seen) != 8 {
		t.Fatalf("ceiling dropped terminals: %d of 8 represented (%v)", len(seen), seen)
	}
}

// Sorted oldest to newest, so the table reads as a timeline.
func TestRecentIsTimeOrdered(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("a", 5, 100)...)
	st.Swaps = append(st.Swaps, mkSwaps("b", 5, 0)...)
	got := recent(st, 15, 900)
	for i := 1; i < len(got); i++ {
		if got[i].Time < got[i-1].Time {
			t.Fatalf("not time-ordered at %d: %d before %d", i, got[i-1].Time, got[i].Time)
		}
	}
}

// Binance's row is the pooled product; its swaps are stored under
// binance-wallet-base and -ethereum, so without the product stamp the
// row's own audit table matched none of its 196 transactions.
func TestRecentStampsTheProductForAPooledRow(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("binance-wallet-base", 4, 0)...)
	st.Swaps = append(st.Swaps, mkSwaps("binance-wallet-ethereum", 4, 100)...)
	st.Swaps = append(st.Swaps, mkSwaps("gmgn", 4, 200)...)

	for _, s := range recent(st, 15, 900) {
		switch s.Terminal {
		case "binance-wallet-base", "binance-wallet-ethereum":
			if s.Product != "binance" {
				t.Fatalf("%s should roll up to binance, got %q", s.Terminal, s.Product)
			}
		case "gmgn":
			// A row that is its own product carries no stamp, so the
			// payload does not repeat the terminal on every swap.
			if s.Product != "" {
				t.Fatalf("gmgn is its own row, want no product stamp, got %q", s.Product)
			}
		}
	}
}

// A chain row keeps its own identity while pointing at its product, so
// /products/gmgn and the gmgn-ethereum row can both find the swap.
func TestRecentStampsTheProductForAChainRow(t *testing.T) {
	st := &State{}
	st.Swaps = append(st.Swaps, mkSwaps("gmgn-ethereum", 3, 0)...)
	got := recent(st, 15, 900)
	if len(got) != 3 {
		t.Fatalf("want 3 swaps, got %d", len(got))
	}
	for _, s := range got {
		if s.Terminal != "gmgn-ethereum" || s.Product != "gmgn" {
			t.Fatalf("want terminal gmgn-ethereum product gmgn, got %q / %q", s.Terminal, s.Product)
		}
	}
}
