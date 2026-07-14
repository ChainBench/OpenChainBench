package main

import (
	"math"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Arb latency: how many seconds it takes for the Uniswap v4 pool to
// come back within convergedBps of the Yahoo reference after a
// reference move of triggerBps or more in a single one-minute window.
// Fires only during market_state="regular" — outside regular hours
// there is no fresh reference to arbitrage against.
//
// Design: the per-symbol event tracker holds the last reference price
// seen, the "in flight" arb event if one is active, and its start
// time. On each tick:
//   - update the trailing 1-minute reference move
//   - if not in flight and the move exceeds triggerBps, start a new
//     event, arm a timer
//   - if in flight and the pool is now within convergedBps, close the
//     event, observe the elapsed seconds into the histogram, tag with
//     the trigger magnitude bucket for filtering
//   - if in flight but not yet converged, keep waiting (no cap: the
//     "unresolved" case is the story we want to tell too)

const (
	arbTriggerBps   = 50.0
	arbConvergedBps = 20.0
	arbMoveWindow   = 90 * time.Second // ~1 minute plus one poll jitter
)

var (
	tspArbLatencySeconds = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "tsp_arb_latency_seconds",
		Help: "Seconds until the pool price converged to within 20 bps of the reference after a 50 bps ref move (regular hours only).",
		// 15s to 30min: 15, 30, 60, 120, 240, 480, 960, 1920 seconds
		Buckets: prometheus.ExponentialBuckets(15, 2, 8),
	}, []string{"asset", "issuer"})

	tspArbEventTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tsp_arb_event_total",
		Help: "Count of arb events per outcome: converged / still_open at rollover.",
	}, []string{"asset", "issuer", "outcome"})

	tspArbOpenAgeSeconds = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tsp_arb_open_age_seconds",
		Help: "Age of the currently-open arb event, if any (0 when no event is in flight).",
	}, []string{"asset", "issuer"})
)

type refSample struct {
	price float64
	at    time.Time
}

type arbTracker struct {
	mu sync.Mutex
	// Ring of recent reference samples per asset, used to derive the
	// trailing move without leaning on Prom's delta().
	refs map[string][]refSample
	// In-flight events per (asset).
	open map[string]arbEvent
}

type arbEvent struct {
	startedAt      time.Time
	triggerBps     float64
	refAtTrigger   float64
	poolAtTrigger  float64
}

func newArbTracker() *arbTracker {
	return &arbTracker{
		refs: make(map[string][]refSample),
		open: make(map[string]arbEvent),
	}
}

// observe consumes one (ref, pool) reading for a symbol; called once
// per tick per asset during regular hours only.
func (t *arbTracker) observe(asset, issuer string, now time.Time, ref, pool float64) {
	if ref <= 0 || pool <= 0 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	// Roll the ref window.
	buf := t.refs[asset]
	buf = append(buf, refSample{price: ref, at: now})
	cut := now.Add(-arbMoveWindow)
	for len(buf) > 0 && buf[0].at.Before(cut) {
		buf = buf[1:]
	}
	t.refs[asset] = buf

	// Trailing 1-minute reference move in bps.
	oldest := buf[0]
	moveBps := 0.0
	if oldest.price > 0 {
		moveBps = math.Abs(ref-oldest.price) / oldest.price * 10000
	}
	devBps := math.Abs(pool-ref) / ref * 10000

	ev, inFlight := t.open[asset]
	tspArbOpenAgeSeconds.WithLabelValues(asset, issuer).Set(0)

	if !inFlight {
		// Start a new event only if the reference actually moved and
		// the pool is currently out of the convergence band. If the
		// pool was already within band during the move, arbs closed
		// it faster than one tick, credit as "sub-poll".
		if moveBps >= arbTriggerBps && devBps > arbConvergedBps {
			t.open[asset] = arbEvent{
				startedAt:     now,
				triggerBps:    moveBps,
				refAtTrigger:  ref,
				poolAtTrigger: pool,
			}
			tspArbOpenAgeSeconds.WithLabelValues(asset, issuer).Set(0)
		}
		return
	}

	// In flight: report age, close on convergence.
	age := now.Sub(ev.startedAt).Seconds()
	tspArbOpenAgeSeconds.WithLabelValues(asset, issuer).Set(age)
	if devBps <= arbConvergedBps {
		tspArbLatencySeconds.WithLabelValues(asset, issuer).Observe(age)
		tspArbEventTotal.WithLabelValues(asset, issuer, "converged").Inc()
		delete(t.open, asset)
	}
}

// closeStaleOnStateChange is called when the market session flips out
// of "regular": any in-flight event is unresolved by market close, so
// we count it as "still_open" without polluting the latency histogram.
func (t *arbTracker) closeStaleOnStateChange(issuer string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for asset := range t.open {
		tspArbEventTotal.WithLabelValues(asset, issuer, "still_open").Inc()
		tspArbOpenAgeSeconds.WithLabelValues(asset, issuer).Set(0)
		delete(t.open, asset)
	}
}
