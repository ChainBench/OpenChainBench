package main

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Per-chain arrival cohort.
//
// Every (provider, chain) connection reports "provider P saw block N at
// time T" into the chain's aggregator. The first report for a block
// opens a collection window (settleWindow); when it expires the cohort
// is scored:
//
//	T0            = earliest arrival among providers
//	lag(provider) = arrival(provider) - T0   → histogram sample
//	winner        = provider at T0           → wins counter
//	gap           = provider healthy on this chain but absent from the
//	                cohort                    → gap counter
//
// The measurement is deliberately RELATIVE: one vantage point cannot
// separate its own network path from provider pipeline latency, but the
// per-block delta between providers over the same path is a fair
// ordering. The fastest provider reads ~0 by construction; the spec's
// editorial copy discloses this.

const (
	// settleWindow is how long a block cohort stays open after the first
	// arrival. 5s covers everything we've observed (worst straggler
	// ~1.5s on ethereum); providers later than this are scored as a gap,
	// which is the honest reading for a push feed.
	settleWindow = 5 * time.Second
	// staleAfter bounds "healthy": a provider absent from a cohort only
	// counts as a gap when it delivered *something* on this chain within
	// staleAfter (otherwise it's just disconnected, which ws_health and
	// ws_reconnects_total already report).
	staleAfter = 120 * time.Second
)

type cohortEntry struct {
	arrivals map[string]time.Time
}

type aggregator struct {
	chain string

	mu           sync.Mutex
	blocks       map[int64]*cohortEntry
	maxFinalized int64
	// lastMsg tracks per-provider liveness on this chain (any accepted
	// head/slot). Used for gap attribution and the ws_health sweeper.
	lastMsg map[string]time.Time
}

var (
	aggregatorsMu sync.Mutex
	aggregators   = map[string]*aggregator{}
)

func aggregatorFor(chain string) *aggregator {
	aggregatorsMu.Lock()
	defer aggregatorsMu.Unlock()
	if a, ok := aggregators[chain]; ok {
		return a
	}
	a := &aggregator{
		chain:   chain,
		blocks:  map[int64]*cohortEntry{},
		lastMsg: map[string]time.Time{},
	}
	aggregators[chain] = a
	return a
}

// record ingests one arrival. Returns false when the arrival was
// dropped (duplicate from the same provider, or a straggler for an
// already-scored block).
func (a *aggregator) record(provider string, height int64, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.lastMsg[provider] = now

	// Straggler for a cohort that already settled. From a push-feed
	// consumer's perspective this block was missed (the gap counter was
	// bumped at settle time); opening a fresh single-provider cohort
	// here would fabricate a lag=0 "win", so drop it.
	if height <= a.maxFinalized {
		return false
	}

	e, ok := a.blocks[height]
	if !ok {
		e = &cohortEntry{arrivals: map[string]time.Time{}}
		a.blocks[height] = e
		time.AfterFunc(settleWindow, func() { a.settle(height) })
	}
	if _, dup := e.arrivals[provider]; dup {
		return false
	}
	e.arrivals[provider] = now
	headBlocksSeen.WithLabelValues(provider, a.chain).Inc()
	return true
}

// settle scores one block cohort and releases it.
func (a *aggregator) settle(height int64) {
	a.mu.Lock()
	e, ok := a.blocks[height]
	if !ok {
		a.mu.Unlock()
		return
	}
	delete(a.blocks, height)
	if height > a.maxFinalized {
		a.maxFinalized = height
	}
	// Snapshot healthy providers for gap attribution while still locked.
	settleTime := time.Now()
	healthy := make([]string, 0, len(a.lastMsg))
	for p, t := range a.lastMsg {
		if settleTime.Sub(t) <= staleAfter {
			healthy = append(healthy, p)
		}
	}
	a.mu.Unlock()

	// A single-provider cohort carries no relative information: lag
	// would be 0 by definition and the "win" unearned. Count gaps for
	// the healthy absentees (they truly missed a block others pushed)
	// but emit no lag samples.
	if len(e.arrivals) >= 2 {
		providers := make([]string, 0, len(e.arrivals))
		for p := range e.arrivals {
			providers = append(providers, p)
		}
		// Deterministic tie-break: earliest arrival wins; equal
		// timestamps resolve alphabetically.
		sort.Strings(providers)
		winner := providers[0]
		t0 := e.arrivals[winner]
		for _, p := range providers[1:] {
			if e.arrivals[p].Before(t0) {
				winner, t0 = p, e.arrivals[p]
			}
		}
		for _, p := range providers {
			lagMs := float64(e.arrivals[p].Sub(t0).Nanoseconds()) / 1e6
			headLagHist.WithLabelValues(p, a.chain).Observe(lagMs)
		}
		headWins.WithLabelValues(winner, a.chain).Inc()
		fmt.Printf("[%s] block=%d cohort=%d winner=%s\n", a.chain, height, len(e.arrivals), winner)
	}

	for _, p := range healthy {
		if _, saw := e.arrivals[p]; !saw {
			headBlockGap.WithLabelValues(p, a.chain).Inc()
		}
	}
}

// startHealthSweeper flips ws_health to 0 for any (provider, chain)
// that stopped delivering messages, per the gauge's contract (1 =
// connected AND received a message in the last 120s). The connection
// goroutines set it back to 1 on every accepted message.
func startHealthSweeper() {
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for now := range t.C {
			aggregatorsMu.Lock()
			aggs := make([]*aggregator, 0, len(aggregators))
			for _, a := range aggregators {
				aggs = append(aggs, a)
			}
			aggregatorsMu.Unlock()
			for _, a := range aggs {
				a.mu.Lock()
				for p, last := range a.lastMsg {
					if now.Sub(last) > staleAfter {
						wsHealth.WithLabelValues(p, a.chain).Set(0)
					}
				}
				a.mu.Unlock()
			}
		}
	}()
}
