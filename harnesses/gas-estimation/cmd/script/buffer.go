package main

import (
	"sync"
	"time"
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
	// CapturedAt is the wall-clock time the poll returned. Used at
	// join time to emit gas_prediction_age_seconds so oracles with
	// slower cadences (e.g. Owlracle 60s) don't silently win/lose
	// on the freshness axis without disclosure.
	CapturedAt time.Time
}

// Buffer stores pending predictions keyed by the block number they
// target. Two parallel maps back it: `pending` is drained by the
// primary grade (join at target block ±1) and `pendingLag2` is
// drained two blocks later so we can grade the same prediction
// against a block +2 further out — the red-team-flagged fix for
// the "next-block winner is whoever scraped the mempool 100 ms
// before us" latency-race bias. Every Add() writes into both maps
// so lag=0 and lag=2 see identical prediction populations.
//
// Sized so that a multi-minute realizer outage doesn't lose data
// silently — entries older than `pendingTTLBlocks` are evicted on
// every join.
type Buffer struct {
	mu          sync.Mutex
	pending     map[uint64][]Prediction
	pendingLag2 map[uint64][]Prediction
}

func NewBuffer() *Buffer {
	return &Buffer{
		pending:     make(map[uint64][]Prediction),
		pendingLag2: make(map[uint64][]Prediction),
	}
}

// Add appends a prediction for the given target block. Callers may
// add multiple predictions for the same (block, oracle) — e.g. one
// per tier — and the realizer will emit one error metric per entry.
// Prediction is inserted into both the primary map and the lag2
// map so the two grade passes see the same population.
func (b *Buffer) Add(targetBlock uint64, p Prediction) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pending[targetBlock] = append(b.pending[targetBlock], p)
	b.pendingLag2[targetBlock] = append(b.pendingLag2[targetBlock], p)
}

// Take returns and removes all primary-side predictions targeting
// the given block. If none are waiting, returns nil.
func (b *Buffer) Take(block uint64) []Prediction {
	b.mu.Lock()
	defer b.mu.Unlock()
	ps := b.pending[block]
	delete(b.pending, block)
	return ps
}

// TakeLag2 returns and removes all lag2-side predictions targeting
// the given block. The realizer calls this with (currentBlock-2),
// i.e. predictions that targeted a block 2 ahead of their capture
// evaluated against the block 2 further out. If none are waiting,
// returns nil.
func (b *Buffer) TakeLag2(block uint64) []Prediction {
	b.mu.Lock()
	defer b.mu.Unlock()
	ps := b.pendingLag2[block]
	delete(b.pendingLag2, block)
	return ps
}

// EvictOlderThan removes any pending entries whose target block is
// strictly less than `floor`. Called by the realizer after each
// successful join to keep both maps bounded if predictions arrive
// for blocks the realizer never sees (network split, oracle skew).
func (b *Buffer) EvictOlderThan(floor uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k := range b.pending {
		if k < floor {
			delete(b.pending, k)
		}
	}
	// Lag2 map needs a floor 2 blocks earlier so it retains the
	// predictions the +2 join is still going to consume.
	lag2Floor := floor
	if lag2Floor >= 2 {
		lag2Floor -= 2
	}
	for k := range b.pendingLag2 {
		if k < lag2Floor {
			delete(b.pendingLag2, k)
		}
	}
}

// Sizes returns a snapshot of pending count per oracle (primary
// map only — the lag2 map trails it by 2 blocks and would otherwise
// double-count for the /metrics buffer-growth gauge).
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
