package main

import (
	"sync"
)

// Prediction is one oracle's tip+base estimate for one specific
// future block. The realizer joins these against the actual block
// once it's mined.
type Prediction struct {
	Oracle Oracle
	Tier   Tier // p25 | p50 | p75 | p90 | p99
	// PriorityGwei is the predicted maxPriorityFeePerGas in gwei.
	PriorityGwei float64
	// BaseGwei is the predicted next-block base fee in gwei. Filled
	// once per oracle per cycle (the same value is attached to every
	// tier prediction for that cycle — base-fee prediction has no
	// tier dimension).
	BaseGwei float64
}

// Buffer stores pending predictions keyed by the block number they
// target. When a block is mined, the realizer fetches the matching
// slice, computes errors, then deletes the entry.
//
// Sized so that a multi-minute realizer outage doesn't lose data
// silently — entries older than `pendingTTLBlocks` are evicted on
// every join.
type Buffer struct {
	mu      sync.Mutex
	pending map[uint64][]Prediction
}

func NewBuffer() *Buffer {
	return &Buffer{pending: make(map[uint64][]Prediction)}
}

// Add appends a prediction for the given target block. Callers may
// add multiple predictions for the same (block, oracle) — e.g. one
// per tier — and the realizer will emit one error metric per entry.
func (b *Buffer) Add(targetBlock uint64, p Prediction) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pending[targetBlock] = append(b.pending[targetBlock], p)
}

// Take returns and removes all predictions targeting the given
// block. If none are waiting, returns nil.
func (b *Buffer) Take(block uint64) []Prediction {
	b.mu.Lock()
	defer b.mu.Unlock()
	ps := b.pending[block]
	delete(b.pending, block)
	return ps
}

// EvictOlderThan removes any pending entries whose target block is
// strictly less than `floor`. Called by the realizer after each
// successful join to keep the map bounded if predictions arrive for
// blocks the realizer never sees (network split, oracle clock skew).
func (b *Buffer) EvictOlderThan(floor uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k := range b.pending {
		if k < floor {
			delete(b.pending, k)
		}
	}
}

// Sizes returns a snapshot of pending count per oracle. Used by the
// metrics goroutine to surface buffer growth.
func (b *Buffer) Sizes() map[Oracle]int {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[Oracle]int)
	for _, ps := range b.pending {
		for _, p := range ps {
			out[p.Oracle]++
		}
	}
	return out
}
