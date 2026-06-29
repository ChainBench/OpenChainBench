package main

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// EventSig is the cross-provider signature we use to match a single trade
// across the 3 streams. After empirical sampling of live traffic we know:
//   - transactionHash: not on Mobula's payload, can't use
//   - outcomeId: encoding differs (Codex wraps in composite scheme)
//   - amountUSD: SEMANTICS differ — Mobula appears to aggregate multiple
//     fills into one event while Polymarket fires one event per fill,
//     so the dollar amount on the same trade ranges 1.4× to 38× off
//
// What ALL three providers report consistently for the same market
// activity: conditionId + the 3-decimal trade price + a coarse 5s time
// bucket. That's the signature. Trade-off: two distinct trades in the
// same market at the same price within a 5-second window collapse into
// one key — acceptable because we record time-to-first-arrival per
// provider, which remains representative of the freshness even when
// collapsed.
type EventSig struct {
	Venue       string // "polymarket" or "kalshi" — distinct venues never match each other
	ConditionId string // Polymarket conditionId OR Kalshi market_ticker, lowercased
	PriceMilli  int    // priceUSD * 1000 rounded
	BucketSec   int64  // floor(trade time / 5s) — coarsens skew between providers
}

func (s EventSig) Key() string {
	v := s.Venue
	if v == "" {
		v = "polymarket"
	}
	return fmt.Sprintf("%s|%s|%d|%d", v, s.ConditionId, s.PriceMilli, s.BucketSec)
}

// Arrival records one provider's receipt of an event keyed by EventSig.
type Arrival struct {
	Provider string // "polymarket", "codex", "mobula"
	Kind     string // "trade" or "price"
	RecvUnix float64
}

type Correlator struct {
	mu sync.Mutex
	// per-signature, per-provider earliest arrival within the retention window
	byKey map[string]map[string]Arrival
	// signature key -> T0 arrival time, where T0 is the direct-venue source
	// (Polymarket CLOB for polymarket venue, Kalshi WS for kalshi venue).
	// Used for fast delta computation when a follower reports later.
	t0 map[string]float64
	// LRU eviction list (key + insertion time)
	insertOrder []keyAt
}

type keyAt struct {
	Key string
	At  float64
}

const retention = 90.0 // seconds; trades that don't match within 90s are forgotten

func NewCorrelator() *Correlator {
	return &Correlator{
		byKey: map[string]map[string]Arrival{},
		t0:    map[string]float64{},
	}
}

// isT0Provider returns true when the given provider is the direct-venue
// source for the given venue (i.e. the reference clock we measure lag from).
func isT0Provider(provider, venue string) bool {
	switch venue {
	case "kalshi":
		return provider == "kalshi"
	default:
		return provider == "polymarket"
	}
}

func (c *Correlator) Add(sig EventSig, a Arrival) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictExpired(a.RecvUnix)

	venue := sig.Venue
	if venue == "" {
		venue = "polymarket"
	}

	key := sig.Key()
	if _, ok := c.byKey[key]; !ok {
		c.byKey[key] = map[string]Arrival{}
		c.insertOrder = append(c.insertOrder, keyAt{Key: key, At: a.RecvUnix})
	}
	if existing, ok := c.byKey[key][a.Provider]; ok && existing.RecvUnix <= a.RecvUnix {
		return
	}
	c.byKey[key][a.Provider] = a

	if isT0Provider(a.Provider, venue) {
		c.t0[key] = a.RecvUnix
		for prov, follower := range c.byKey[key] {
			if isT0Provider(prov, venue) {
				continue
			}
			observeDelta(prov, venue, follower.Kind, follower.RecvUnix-a.RecvUnix)
		}
		return
	}

	if t0, ok := c.t0[key]; ok {
		observeDelta(a.Provider, venue, a.Kind, a.RecvUnix-t0)
	}
}

func observeDelta(provider, venue, kind string, deltaSec float64) {
	if deltaSec < 0 {
		deltaSec = 0
	}
	ms := deltaSec * 1000
	if math.IsNaN(ms) || math.IsInf(ms, 0) {
		return
	}
	freshnessDelta.WithLabelValues(provider, venue, kind).Observe(ms)
	matchedTotal.WithLabelValues(provider, venue, kind).Inc()
}

func (c *Correlator) evictExpired(now float64) {
	cutoff := now - retention
	cut := 0
	for cut < len(c.insertOrder) && c.insertOrder[cut].At < cutoff {
		k := c.insertOrder[cut].Key
		delete(c.byKey, k)
		delete(c.t0, k)
		cut++
	}
	if cut > 0 {
		c.insertOrder = c.insertOrder[cut:]
	}
}

func priceToMilli(price string) int {
	f := parseF(price)
	return int(math.Round(f * 1000))
}

func amountToCents(s string) int64 {
	return int64(math.Round(parseF(s) * 100))
}

func amountFloatToCents(f float64) int64 {
	return int64(math.Round(f * 100))
}

func parseF(s string) float64 {
	if s == "" {
		return 0
	}
	var f float64
	fmt.Sscanf(strings.TrimSpace(s), "%f", &f)
	return f
}

func bucketSec(t float64) int64 {
	return int64(t / 5)
}

func nowSec() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

// logSigSample prints the first 5 signatures per provider so we can eyeball
// cross-provider alignment when matched_total stays at zero. Pure debug
// instrumentation, dropped from output once we trust the matching.
var (
	sigSampleMu sync.Mutex
	sigSamples  = map[string]int{}
)

func logSigSample(provider string, s EventSig) {
	sigSampleMu.Lock()
	defer sigSampleMu.Unlock()
	key := provider + "/" + s.Venue
	if sigSamples[key] >= 5 {
		return
	}
	sigSamples[key]++
	cid := s.ConditionId
	if len(cid) > 14 {
		cid = cid[:14]
	}
	appendLog("[sig %s/%s #%d] cond=%s price=%d bucket=%d",
		provider, s.Venue, sigSamples[key], cid, s.PriceMilli, s.BucketSec)
}
