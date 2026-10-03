package main

import (
	"sync"
	"time"
)

// Deferred reference matching.
//
// Every provider monitor used to look the trade up in the reference clock
// at the instant it received the emission. That only works when the
// reference is earlier than the provider. On Solana it is not: our
// logsSubscribe observation lands about 0.2 s after Mobula and Serialized,
// who read a geyser, so at lookup time the entry does not exist yet and the
// emission is counted as unmatched. Measured in production before this
// change: Codex, the slowest, matched 5% of its Solana emissions; Mobula and
// Serialized, faster, matched 0%. The asymmetry is the order of arrival,
// not rate limiting.
//
// Emissions now wait in a short-lived buffer and are resolved when the
// reference catches up, or expired as a miss after pendingDeadline. This
// makes the match independent of which side arrives first, which is the
// property a reference clock needs to have on every chain, not just on
// Base where the flashblock stream happens to precede everyone.
//
// The buffer is also where the Base and Solana headline lag is computed:
// those chains publish the reference-based number, so a sample that never
// matches is dropped from head_lag_seconds rather than silently measured
// against the provider's own timestamp. See headlineLag.

const (
	pendingDeadline    = 8 * time.Second
	pendingResolveTick = 200 * time.Millisecond
)

type pendingEmission struct {
	aggregator  string
	chain       string
	region      string
	hash        string
	receiveTime time.Time
	lagBlocks   int64
	providerLag float64 // receiveTime minus the provider's own on-chain timestamp
}

type pendingQueue struct {
	mu    sync.Mutex
	items []pendingEmission
}

var pending = &pendingQueue{}

// referenceChains are the chains whose headline lag is measured against our
// own reference clock. Base: the flashblock stream, which precedes the
// sealed block by ~1.6 s.
//
// Solana is handled by race.go instead (raceChains): no RPC WebSocket we
// can hold precedes the providers' geyser feeds, so its headline is the
// lag behind the first observation of the trade rather than behind our
// node. Add a chain here only once its reference is measured to arrive
// before every provider (head_lag_ref_seconds positive for all of them).
//
// BNB joined 2026-10-03, against that gate and because the column it
// replaces was mostly measuring the chain. On the provider-timestamp
// figure the four providers sat within 9 % of each other (eu-west p50:
// mobula 0.621 s, serialized 0.657 s, codex 0.676 s) because the dominant
// term was BNB's block time, which every provider shares. Against the
// reference they spread over a factor of four (0.052 / 0.102 / 0.215),
// and the ranking is unchanged, so this removes a common offset rather
// than reshuffling anyone.
//
// The gate itself: our node is beaten to a trade 6.6 % of the time by
// mobula on BNB, 4.7 % by serialized, 3.7 % by codex. Base, already here
// and shipping, sits at 4.2 % / 3.1 % / 0 %. Same order, measured over
// 8,604 samples per provider.
//
// It also retires a published claim that did not survive measurement.
// The spec said BNB's chain-supplied timestamps sat "within roughly 60 ms
// of the moment a trade is observable". The gap between the two series is
// exactly that quantity, and it is 569 ms.
var referenceChains = map[string]bool{"base": true, "bnb": true}

// tokenScopedAggregators cannot scope their subscription to a pool, so they
// push every pool on a token and most of what they send is off-bench.
//
// This changes nothing about what is scored: only emissions matched to the
// reference by transaction hash are, and the reference is the bench pool, so
// the scored set is the same for every provider. It changes only the miss
// counter, which for these providers would otherwise be dominated by trades
// that were never supposed to match.
//
// OKX is here because six ways of passing a pool address to its channel are
// accepted and silently ignored, and its paid channel is token-scoped too.
// Measured on the Base pool over 20 minutes: 213 of 213 pool swaps present,
// so the coverage this relies on is not assumed.
var tokenScopedAggregators = map[string]bool{"okx": true}

// emitHeadLag is the single entry point for a provider emission.
//
// Chains outside referenceChains keep publishing the provider-timestamp
// figure immediately, exactly as before. Every chain enqueues for the
// reference match, so head_lag_ref_seconds is populated everywhere.
func emitHeadLag(aggregator, chain, region, hash string, receiveTime time.Time, lagBlocks int64, providerLag float64) {
	// raceChains publish the lag behind the first observation instead
	// (race.go); referenceChains publish the lag behind our node once the
	// match resolves. Everything else keeps the provider-timestamp figure.
	if !referenceChains[chain] && !raceChains[chain] {
		RecordHeadLag(aggregator, chain, lagBlocks, providerLag, region, hash)
	}
	if hash == "" {
		return
	}
	race.observe(aggregator, chain, region, hash, receiveTime, lagBlocks)
	pending.mu.Lock()
	pending.items = append(pending.items, pendingEmission{
		aggregator: aggregator, chain: chain, region: region, hash: hash,
		receiveTime: receiveTime, lagBlocks: lagBlocks, providerLag: providerLag,
	})
	pending.mu.Unlock()
}

// resolveOne records what can be recorded for a matched emission.
func resolveOne(e pendingEmission, refAt time.Time) {
	lag := e.receiveTime.Sub(refAt).Seconds()
	RecordHeadLagRef(e.aggregator, e.chain, lag, e.region)
	if referenceChains[e.chain] {
		RecordHeadLag(e.aggregator, e.chain, e.lagBlocks, lag, e.region, e.hash)
	}
}

// runPendingResolver sweeps the buffer: matched entries are resolved,
// entries older than pendingDeadline are counted as misses. Never blocks a
// provider's read loop.
func runPendingResolver(stopChan <-chan struct{}) {
	t := time.NewTicker(pendingResolveTick)
	defer t.Stop()
	for {
		select {
		case <-stopChan:
			return
		case <-t.C:
		}
		now := time.Now()
		race.resolve(now)
		pending.mu.Lock()
		keep := pending.items[:0]
		for _, e := range pending.items {
			if refAt, ok := reference.lookup(e.chain, e.hash); ok {
				resolveOne(e, refAt)
				continue
			}
			if now.Sub(e.receiveTime) > pendingDeadline {
				// A token-scoped provider sends us every pool on the token,
				// so an emission the reference never saw is a trade from
				// another pool, not a failure. Counting it would read as a
				// 96%-miss provider and would drown the signal this counter
				// exists for: whether the reference itself is healthy.
				if !tokenScopedAggregators[e.aggregator] {
					RecordHeadLagRefMiss(e.aggregator, e.chain, e.region)
				}
				continue
			}
			keep = append(keep, e)
		}
		pending.items = keep
		pending.mu.Unlock()
	}
}
