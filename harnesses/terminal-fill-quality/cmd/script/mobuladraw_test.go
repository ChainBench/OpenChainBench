package main

import (
	"testing"
	"time"
)

// Nothing the watcher paired may be destroyed by an over-quota tick.
//
// The version this replaces drained the whole buffer and kept the quota, so
// the surplus was gone for good: 188 of 202 Robinhood fills, on a route where
// Robinhood is most of the flow. Every other sampler on this bench leaves
// what it does not draw in its feed.
func TestDrawKeepsWhatItDoesNotTake(t *testing.T) {
	w := newMobulaFillWatcher()
	for i := 0; i < 50; i++ {
		w.queue(mobulaPaired{chain: "robinhood", fill: fillHash(i), in: mobulaIntent{At: 1, Amount: 1, App: "fomo-mobula"}})
	}
	got := w.draw(4)
	if len(got) != 4 {
		t.Fatalf("draw(4) returned %d", len(got))
	}
	if n := w.backlog(); n != 46 {
		t.Fatalf("backlog is %d after drawing 4 of 50, want 46: the surplus was discarded", n)
	}
	// And the rest is still drawable, so the quota defers rather than drops.
	total := 4
	for i := 0; i < 20 && w.backlog() > 0; i++ {
		total += len(w.draw(4))
	}
	if total != 50 {
		t.Fatalf("drew %d of 50 across successive ticks; the rest was lost", total)
	}
}

// The draw must be RANDOM, not arrival-ordered. Taking the first n biases
// toward whatever getLogs returned first, which correlates with the chain and
// with position in a block range, and the spec says "drawn at random".
//
// Queue a buffer in a known order, draw one item many times from a fresh
// buffer each round, and require more than one distinct first pick. A
// first-n implementation returns the same item every round.
func TestDrawIsRandomNotArrivalOrdered(t *testing.T) {
	seen := map[string]bool{}
	for round := 0; round < 40; round++ {
		w := newMobulaFillWatcher()
		for i := 0; i < 12; i++ {
			w.queue(mobulaPaired{chain: "bnb", fill: fillHash(i), in: mobulaIntent{At: 1, Amount: 1, App: "fomo-mobula"}})
		}
		got := w.draw(1)
		if len(got) != 1 {
			t.Fatalf("draw(1) returned %d", len(got))
		}
		seen[got[0].fill] = true
	}
	if len(seen) < 3 {
		t.Fatalf("40 draws from a 12-item buffer produced %d distinct picks: the draw is ordered, not random", len(seen))
	}
}

// The cap still bounds the buffer, so a tick that stops drawing cannot grow
// it without end.
func TestQueueStaysBounded(t *testing.T) {
	w := newMobulaFillWatcher()
	for i := 0; i < mobulaPendingMax+200; i++ {
		w.queue(mobulaPaired{chain: "base", fill: fillHash(i), in: mobulaIntent{At: 1, Amount: 1, App: "fomo-mobula"}})
	}
	if n := w.backlog(); n > mobulaPendingMax {
		t.Fatalf("backlog is %d, past the %d cap", n, mobulaPendingMax)
	}
}

// Drawing from an empty buffer is not an error and must not block.
func TestDrawOnEmptyBuffer(t *testing.T) {
	w := newMobulaFillWatcher()
	done := make(chan int, 1)
	go func() { done <- len(w.draw(8)) }()
	select {
	case n := <-done:
		if n != 0 {
			t.Fatalf("drew %d from an empty buffer", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("draw on an empty buffer blocked")
	}
}

func fillHash(i int) string {
	const hexd = "0123456789abcdef"
	out := "0x"
	for s := 0; s < 8; s++ {
		out += string(hexd[(i>>(s*4))&0xf])
	}
	return out
}
