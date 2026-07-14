package main

import (
	"context"
	"math"
	"sync"
	"time"
)

// Freshness tracking for OCB bench № 082 (oracle-freshness).
//
// Every freshness-capable poller calls recordFreshness with the
// source-declared update timestamp:
//
//   - Chainlink: latestRoundData().updatedAt, per chain (ethereum,
//     arbitrum, base). Push oracle: staleness in the multiple hundreds
//     of seconds is EXPECTED in calm markets (deviation trigger +
//     heartbeat mechanics), not a failure.
//   - Pyth: Hermes publish_time. Pull oracle: Hermes IS the price
//     source integrators pull from, so publish_time is the honest
//     freshness measure (typically 1-2s).
//   - RedStone: the signed data-package timestamp from the public
//     per-symbol API (typically 15-25s; packages are produced on a
//     ~10s cadence).
//
// Because "old" is not the same as "wrong" for a push oracle, the
// bench pairs raw staleness with a second signal: stale_but_moved,
// which only fires when the feed is old AND the market has left it
// behind. Thresholds:
//
//   staleThresholdSeconds (300s): half of Chainlink's typical 1h
//     heartbeat divided by 6 is arbitrary; 300s was picked because
//     every observed healthy update gap on the measured feeds
//     (deviation-triggered) lands under it EXCEPT genuinely quiet
//     periods, and because 5 minutes of price lag is where perp/
//     lending liquidation math starts to hurt.
//   staleMoveThresholdPct (0.5%): matches the widest deviation
//     trigger configured on the measured Chainlink feeds. If the CEX
//     print moved more than the feed's own trigger and the feed still
//     hasn't updated, the feed is late by its own standard.
const (
	staleThresholdSeconds = 300.0
	staleMoveThresholdPct = 0.5
	// freshnessTickInterval refreshes the staleness gauges between
	// polls so the gauge grows monotonically instead of stair-stepping
	// on the 30s poll cadence.
	freshnessTickInterval = 5 * time.Second
)

// chain label values. For Chainlink the label is the chain the
// aggregator contract lives on. Pyth and RedStone are not read from a
// chain at all (pull-model oracles); their freshness source is named
// instead.
const (
	ChainEthereum = "ethereum"
	ChainArbitrum = "arbitrum"
	ChainBase     = "base"
	ChainHermes   = "hermes"  // Pyth Hermes publish_time
	ChainGateway  = "gateway" // RedStone public data gateway
)

type freshKey struct {
	oracle string
	pair   Pair
	chain  string
}

type freshState struct {
	// lastUpdate is the source-declared timestamp of the feed's most
	// recent update (NOT our fetch time).
	lastUpdate time.Time
	// cexAtUpdate is the CEX reference price snapshotted when we first
	// observed this update. 0 when no fresh CEX sample was available.
	// Cold-start caveat: for a feed whose current round predates the
	// harness boot, the snapshot is taken at boot, not at the round's
	// true landing time; it converges on the first real update event.
	cexAtUpdate float64
}

var (
	freshMu sync.Mutex
	fresh   = make(map[freshKey]freshState)
)

// recordFreshness ingests one observation of a feed's own update
// timestamp. Increments the update-events counter when the timestamp
// moved forward vs the previous observation, snapshots the CEX
// reference at that moment, then republishes the gauges.
func recordFreshness(oracle string, pair Pair, chain string, sourceTS time.Time) {
	if sourceTS.Unix() <= 0 {
		// A zero/absent timestamp would read as ~56 years of staleness.
		freshnessScrapeErrors.WithLabelValues(oracle, string(pair), chain).Inc()
		return
	}
	key := freshKey{oracle: oracle, pair: pair, chain: chain}
	freshMu.Lock()
	st, seen := fresh[key]
	if !seen || sourceTS.After(st.lastUpdate) {
		if seen {
			oracleUpdateEvents.WithLabelValues(oracle, string(pair), chain).Inc()
		}
		ref, _ := cexRefPrice(pair)
		st = freshState{lastUpdate: sourceTS, cexAtUpdate: ref}
		fresh[key] = st
	}
	freshMu.Unlock()
	publishFreshness(key, st)
}

// publishFreshness sets the staleness + stale_but_moved gauges for one
// (oracle, pair, chain) from its stored state.
func publishFreshness(key freshKey, st freshState) {
	stale := time.Since(st.lastUpdate).Seconds()
	if stale < 0 {
		// Source clock marginally ahead of ours (Hermes publish_time
		// can lead by sub-second). Clamp instead of publishing a
		// negative age.
		stale = 0
	}
	oracleStalenessSeconds.WithLabelValues(key.oracle, string(key.pair), key.chain).Set(stale)

	moved := 0.0
	if stale > staleThresholdSeconds && st.cexAtUpdate > 0 {
		if cur, ok := cexRefPrice(key.pair); ok {
			movePct := math.Abs(cur-st.cexAtUpdate) / st.cexAtUpdate * 100
			if movePct > staleMoveThresholdPct {
				moved = 1
			}
		}
	}
	oracleStaleButMoved.WithLabelValues(key.oracle, string(key.pair), key.chain).Set(moved)
}

// cexRefPrice returns the freshest CEX print for a pair from the
// existing 025 price store: Binance first, Coinbase as fallback, both
// subject to the same 2x-poll-interval staleness guard the deviation
// calc uses. ok=false when neither has a fresh sample.
func cexRefPrice(pair Pair) (float64, bool) {
	storeMu.RLock()
	defer storeMu.RUnlock()
	srcMap := store[pair]
	if srcMap == nil {
		return 0, false
	}
	for _, src := range []Source{SourceBinance, SourceCoinbase} {
		if p, ok := srcMap[src]; ok && time.Since(p.TS) <= 2*pollInterval {
			return p.Value, true
		}
	}
	return 0, false
}

// runFreshnessUpdater republishes every tracked freshness gauge on a
// short cadence so staleness keeps climbing between the 30s polls (a
// Prometheus scrape landing mid-window sees the true age, not the age
// as of the last poll).
func runFreshnessUpdater(ctx context.Context) {
	t := time.NewTicker(freshnessTickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			freshMu.Lock()
			snapshot := make(map[freshKey]freshState, len(fresh))
			for k, v := range fresh {
				snapshot[k] = v
			}
			freshMu.Unlock()
			for k, v := range snapshot {
				publishFreshness(k, v)
			}
		}
	}
}
