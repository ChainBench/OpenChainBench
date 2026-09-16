package main

import (
	"sort"
	"sync"
	"time"
)

// Per-transaction race between every feed that reports a trade.
//
// The question integrators actually ask is "which feed gives me the trade
// first, and by how much". The deferred matcher (pending_match.go) already
// buffers every emission by transaction hash; this file adds the race on
// top: for each (chain, region, hash) it keeps the arrival time of every
// provider plus our own node reference, closes the race raceWindow after
// the first arrival, and publishes
//
//   - head_lag_first_total{aggregator,chain,region}: how often each feed
//     (the node reference included, as aggregator="reference") reported
//     the trade first. Arrivals within raceTie of the earliest count as
//     first for every feed involved: below that, the order is network
//     jitter between our probe and two servers, not a property of the
//     feeds.
//   - head_lag_races_total{chain,region}: races closed.
//   - head_lag_first_share_pct{aggregator,chain,region}: the share over a
//     rolling 24 h, computed in-process so the bench can read it as a
//     plain gauge.
//
// On raceChains the headline head_lag_seconds becomes the lag behind the
// first observation of the trade instead of the lag behind the provider's
// own timestamp. Solana is the first such chain: there is no on-chain
// timestamp with sub-second precision, so Mobula's `date` (its ingestion
// time, ~100 ms constant) and Serialized's `at` (blockTime, whole
// seconds, +0.5 s on average) compared conventions rather than delivery;
// measured against a common clock the two feeds are 10-30 ms apart. No
// public or keyed RPC WebSocket precedes their geysers (Helius: ~110 ms
// behind on every trade; Alchemy: level on half the trades, 3.5 s late or
// absent on the other half; mainnet-beta: ~110 ms behind), so an absolute
// clock is not available without a geyser-grade feed. The reference still
// runs in the race: it validates that the hash exists on chain, and it
// bounds the field whenever a feed is slower than a plain node.
//
// Feeds that arrive after the race closed (GeckoTerminal polls, 15-100 s
// later) still get their lag against the recorded first arrival: closed
// races are kept raceRetention.

const (
	raceWindow    = 3 * time.Second
	raceTie       = 5 * time.Millisecond
	raceRetention = 10 * time.Minute
	raceShareSpan = 24 * time.Hour
	raceMaxOpen   = 50000
)

// raceChains publishes head_lag_seconds as the lag behind the first
// observation instead of the provider-timestamp figure.
var raceChains = map[string]bool{"solana": true}

type raceObs struct {
	aggregator string
	at         time.Time
	lagBlocks  int64
}

type raceEntry struct {
	chain, region string
	opened        time.Time // first arrival, wall clock of this probe
	t0            time.Time // earliest observation, reference included once closed
	obs           []raceObs
	closed        bool
	void          bool // closed with a single participant: nothing recorded
	closedAt      time.Time
}

type raceResult struct {
	at      time.Time
	winners []string
}

type raceBook struct {
	mu      sync.Mutex
	entries map[string]*raceEntry // "chain|region|hash"
	// Rolling window of closed races per (chain, region) for the share
	// gauge. Bounded by raceShareSpan.
	history map[string][]raceResult
	// Every feed that took part in a race per (chain, region), so a feed
	// that never wins is still published at 0 %.
	participants map[string]map[string]bool
}

var race = &raceBook{
	entries:      map[string]*raceEntry{},
	history:      map[string][]raceResult{},
	participants: map[string]map[string]bool{},
}

func raceKey(chain, region, hash string) string {
	return chain + "|" + region + "|" + hash
}

// observe records a provider arrival. Called from emitHeadLag for every
// chain; the headline substitution only applies to raceChains.
func (b *raceBook) observe(aggregator, chain, region, hash string, at time.Time, lagBlocks int64) {
	if hash == "" {
		return
	}
	k := raceKey(chain, region, hash)
	b.mu.Lock()
	defer b.mu.Unlock()
	e, ok := b.entries[k]
	if !ok {
		if len(b.entries) >= raceMaxOpen {
			return
		}
		e = &raceEntry{chain: chain, region: region, opened: at, t0: at}
		b.entries[k] = e
	}
	if e.closed {
		if e.void {
			return // single-feed race: no ruler to measure against
		}
		// Late arrival: it lost, and its lag is against the recorded first.
		b.note(chain, region, aggregator)
		if raceChains[chain] {
			RecordHeadLag(aggregator, chain, lagBlocks, at.Sub(e.t0).Seconds(), region, hash)
		}
		return
	}
	for _, o := range e.obs {
		if o.aggregator == aggregator {
			return // duplicate delivery (reconnect replay): keep the first
		}
	}
	e.obs = append(e.obs, raceObs{aggregator: aggregator, at: at, lagBlocks: lagBlocks})
	if at.Before(e.t0) {
		e.t0 = at
	}
}

func (b *raceBook) note(chain, region, aggregator string) {
	pk := chain + "|" + region
	if b.participants[pk] == nil {
		b.participants[pk] = map[string]bool{}
	}
	b.participants[pk][aggregator] = true
}

// resolve closes races older than raceWindow and expires closed ones past
// raceRetention. Called from the pending resolver tick.
func (b *raceBook) resolve(now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, e := range b.entries {
		if e.closed {
			if now.Sub(e.closedAt) > raceRetention {
				delete(b.entries, k)
			}
			continue
		}
		if now.Sub(e.opened) < raceWindow {
			continue
		}
		b.closeLocked(e, k)
	}
}

func (b *raceBook) closeLocked(e *raceEntry, k string) {
	hash := k[len(e.chain)+len(e.region)+2:]
	// Our own node takes part when it saw the trade. It also validates
	// that the hash is real; a race nobody but a single provider saw is
	// still closed, but carries no reference lag.
	refSeen := false
	if refAt, ok := reference.lookup(e.chain, hash); ok {
		refSeen = true
		if refAt.Before(e.t0) {
			e.t0 = refAt
		}
		e.obs = append(e.obs, raceObs{aggregator: "reference", at: refAt})
	}
	// A race needs two participants to say anything about order. A trade
	// only one feed reported (GeckoTerminal lists pool trades the push
	// feeds filter out, and our node can miss one) would otherwise hand
	// that feed a "first" and a zero lag it did not earn.
	if len(e.obs) < 2 {
		e.closed = true
		e.void = true
		e.closedAt = time.Now()
		return
	}
	winners := []string{}
	for _, o := range e.obs {
		b.note(e.chain, e.region, o.aggregator)
		delta := o.at.Sub(e.t0)
		if delta <= raceTie {
			winners = append(winners, o.aggregator)
			headLagFirst.WithLabelValues(o.aggregator, e.chain, e.region).Inc()
		}
		if o.aggregator != "reference" && raceChains[e.chain] {
			RecordHeadLag(o.aggregator, e.chain, o.lagBlocks, delta.Seconds(), e.region, hash)
		}
	}
	if !refSeen {
		b.note(e.chain, e.region, "reference")
	}
	headLagRaces.WithLabelValues(e.chain, e.region).Inc()
	e.closed = true
	e.closedAt = time.Now()

	// Rolling 24 h share.
	pk := e.chain + "|" + e.region
	hist := append(b.history[pk], raceResult{at: e.closedAt, winners: winners})
	cut := e.closedAt.Add(-raceShareSpan)
	i := 0
	for i < len(hist) && hist[i].at.Before(cut) {
		i++
	}
	hist = hist[i:]
	b.history[pk] = hist
	wins := map[string]int{}
	for _, r := range hist {
		for _, w := range r.winners {
			wins[w]++
		}
	}
	names := make([]string, 0, len(b.participants[pk]))
	for a := range b.participants[pk] {
		names = append(names, a)
	}
	sort.Strings(names)
	for _, a := range names {
		headLagFirstShare.WithLabelValues(a, e.chain, e.region).Set(float64(wins[a]) / float64(len(hist)) * 100)
	}
}
