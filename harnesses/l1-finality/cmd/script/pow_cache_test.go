package main

import "testing"

// Ten blocks per /api/blocks call and 12 confirmations: once the tip has
// moved past tip-12 having been seen, the lag comes from memory.
func TestEsploraSeenCoversTheConfirmationDepth(t *testing.T) {
	b := &blockTimes{byChain: map[string]map[int64]int64{}}
	window := func(tip int64) []esploraBlock {
		var out []esploraBlock
		for h := tip; h > tip-10; h-- {
			out = append(out, esploraBlock{Height: h, Timestamp: h * 150})
		}
		return out
	}
	b.remember("litecoin", window(100))
	if _, ok := b.lookup("litecoin", 88); ok {
		t.Fatal("88 was never in a window")
	}
	b.remember("litecoin", window(103))
	ts, ok := b.lookup("litecoin", 91)
	if !ok || ts != 91*150 {
		t.Fatalf("tip 103 - 12 = 91 should be remembered, got %d %v", ts, ok)
	}
	b.remember("litecoin", window(100+esploraKeep+20))
	if _, ok := b.lookup("litecoin", 91); ok {
		t.Fatal("old heights must be pruned")
	}
}
