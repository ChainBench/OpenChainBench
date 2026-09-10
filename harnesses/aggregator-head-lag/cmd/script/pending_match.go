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
// Solana is next, and deliberately not yet. Mobula and Serialized report
// on-chain timestamps that differ by ~0.56 s for the same transaction, so
// measuring each against its own timestamp compares conventions rather than
// delivery, and the headline must move to the reference. But the reference
// subscription on the free public endpoint matched 0-5% of emissions before
// this change, and flipping the headline onto a series that thin would
// blank Solana on the bench. Order of operations: ship the deferred
// matcher, point REF_WS_URL_SOLANA at an endpoint that delivers, confirm
// the match rate per region on head_lag_ref_matches_total, then add
// "solana" here.
var referenceChains = map[string]bool{"base": true}

// emitHeadLag is the single entry point for a provider emission.
//
// Chains outside referenceChains keep publishing the provider-timestamp
// figure immediately, exactly as before. Every chain enqueues for the
// reference match, so head_lag_ref_seconds is populated everywhere.
func emitHeadLag(aggregator, chain, region, hash string, receiveTime time.Time, lagBlocks int64, providerLag float64) {
	if !referenceChains[chain] {
		RecordHeadLag(aggregator, chain, lagBlocks, providerLag, region, hash)
	}
	if hash == "" {
		return
	}
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
		pending.mu.Lock()
		keep := pending.items[:0]
		for _, e := range pending.items {
			if refAt, ok := reference.lookup(e.chain, e.hash); ok {
				resolveOne(e, refAt)
				continue
			}
			if now.Sub(e.receiveTime) > pendingDeadline {
				RecordHeadLagRefMiss(e.aggregator, e.chain, e.region)
				continue
			}
			keep = append(keep, e)
		}
		pending.items = keep
		pending.mu.Unlock()
	}
}
