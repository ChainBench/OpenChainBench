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
// behind.
//
// Corrected 2026-10-09. The thresholds used to be two uniform constants, and
// the claim that 0.5% "matches the widest deviation trigger configured on the
// measured Chainlink feeds" was simply false: per Chainlink's own published
// directory the widest is 2%, four times that, and SOL, AVAX, BNB and MATIC
// run 24h heartbeats, 288 times the 300s bar. The effect was measurable, not
// theoretical: AVAX/USD at 7.6h and BNB/USD at 8.3h both read
// stale_but_moved=1 while behaving exactly as configured, because a 24h feed
// was being graded against a 1h feed's promise.
//
// Each feed is now judged against its own published promise, in
// chainlinkPromise (config.go):
//
//   stale_but_moved fires when the CEX reference has moved beyond THAT feed's
//     deviation threshold and the feed still has not written, after a grace
//     period. That is the feed late by its own standard, which is what the
//     metric always claimed to mean.
//   heartbeat_breach fires when the feed has exceeded its own maximum silence.
//
//   updateGraceSeconds (300s) is no longer a staleness bar, it is the time an
//     oracle legitimately needs to observe a move, aggregate and land a
//     transaction. Without it every threshold crossing would flag for the
//     seconds before the update arrives.
//
// Sources with no published promise (Pyth Hermes, the RedStone gateway) are
// pull oracles and keep the legacy constants, flagged below.
const (
	updateGraceSeconds = 300.0
	// Fallback deviation bar for sources that publish no per-feed promise.
	fallbackMoveThreshold = 0.5
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

	// Grade the feed against its own published promise where it has one.
	// A pull oracle (Hermes, the RedStone gateway) publishes no deviation
	// trigger or heartbeat, so it keeps the legacy constants.
	moveBar := fallbackMoveThreshold
	heartbeat := 0.0
	if p, ok := chainlinkPromise[key.pair]; ok && key.oracle == "chainlink" {
		moveBar = p.ThresholdPct
		heartbeat = p.HeartbeatSeconds
	}

	// Late by its own standard: the market crossed THIS feed's trigger and the
	// feed still has not written, past the grace an update legitimately needs.
	moved := 0.0
	if stale > updateGraceSeconds && st.cexAtUpdate > 0 {
		if cur, ok := cexRefPrice(key.pair); ok {
			movePct := math.Abs(cur-st.cexAtUpdate) / st.cexAtUpdate * 100
			if movePct > moveBar {
				moved = 1
			}
		}
	}
	oracleStaleButMoved.WithLabelValues(key.oracle, string(key.pair), key.chain).Set(moved)

	// Silent for longer than it promised. Only published for feeds that state
	// a heartbeat; the gauge is absent rather than 0 for the others, so an
	// empty series cannot be read as "never breached".
	if heartbeat > 0 {
		breach := 0.0
		if stale > heartbeat {
			breach = 1
		}
		oracleHeartbeatBreach.WithLabelValues(key.oracle, string(key.pair), key.chain).Set(breach)
	}
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
