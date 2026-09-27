package main

// window.go — the 24h sliding window of liquidation notionals, the dedup
// SeenSet pruned alongside it, and the 24h sample window that averages open
// interest.
//
// Two kinds of event land in the window and they need different treatment.
//
// An *event* source (an on-chain log, a trade tape row) reports an immutable
// fact once: the same key must never be counted twice, which is what SeenSet
// is for. A *bucket* source (Coinalyze publishes hourly liquidation totals)
// reports a figure that grows while its hour is still open, so re-observing
// the same key carries a larger number that must replace the one already
// stored. Treating a bucket like an event froze every hour at the value it
// had a few minutes after the hour began: Lighter read $887 against a
// $185.6M of daily ETH volume until 2026-09-27 because of it.

import (
	"sync"
	"time"
)

type windowEntry struct {
	key      string
	tsMs     int64
	notional float64
}

// SlidingWindow accumulates (key, unix_ms, notional_usd) events and answers
// the rolling sum over its span. All methods are safe for concurrent use.
type SlidingWindow struct {
	mu      sync.Mutex
	entries []windowEntry
	byKey   map[string]int // key -> index into entries, for Upsert
	span    time.Duration
	firstAt time.Time // wall time of the first tick that touched this window
}

// NewSlidingWindow returns a window covering the given span (24h here).
func NewSlidingWindow(span time.Duration) *SlidingWindow {
	return &SlidingWindow{span: span, byKey: make(map[string]int)}
}

// Add appends one event to the window. Callers gate on SeenSet first so the
// same event key is never appended twice.
func (w *SlidingWindow) Add(key string, tsMs int64, notionalUSD float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.appendLocked(windowEntry{key: key, tsMs: tsMs, notional: notionalUSD})
}

// Upsert stores a bucketed figure: if the key is already in the window its
// notional and timestamp are replaced, otherwise the entry is appended.
// Returns true when the stored value changed, so callers can log movement.
func (w *SlidingWindow) Upsert(key string, tsMs int64, notionalUSD float64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if i, ok := w.byKey[key]; ok {
		if w.entries[i].notional == notionalUSD {
			return false
		}
		w.entries[i].notional = notionalUSD
		w.entries[i].tsMs = tsMs
		return true
	}
	w.appendLocked(windowEntry{key: key, tsMs: tsMs, notional: notionalUSD})
	return true
}

// Remove drops the entry held under key, if any. A bucket source that
// restates its figure as zero is saying the window no longer holds that
// hour or that total, and the entry must go rather than linger at its last
// non-zero value until it ages out. Returns true when something was removed.
func (w *SlidingWindow) Remove(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	i, ok := w.byKey[key]
	if !ok {
		return false
	}
	w.entries = append(w.entries[:i], w.entries[i+1:]...)
	w.byKey = make(map[string]int, len(w.entries))
	for j, e := range w.entries {
		w.byKey[e.key] = j
	}
	return true
}

func (w *SlidingWindow) appendLocked(e windowEntry) {
	w.entries = append(w.entries, e)
	w.byKey[e.key] = len(w.entries) - 1
}

// MarkTick records the first time a tick ran against this window; used by
// IsWarm to decide when a full span of data has been observed.
func (w *SlidingWindow) MarkTick(now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.firstAt.IsZero() {
		w.firstAt = now
	}
}

// Prune drops entries older than span relative to nowMs.
func (w *SlidingWindow) Prune(nowMs int64) {
	cutoff := nowMs - w.span.Milliseconds()
	w.mu.Lock()
	defer w.mu.Unlock()
	kept := w.entries[:0]
	for _, e := range w.entries {
		if e.tsMs >= cutoff {
			kept = append(kept, e)
		}
	}
	// Zero the tail so pruned entries do not linger in the backing array.
	for i := len(kept); i < len(w.entries); i++ {
		w.entries[i] = windowEntry{}
	}
	w.entries = kept
	// The index holds positions, so it has to be rebuilt after a compaction.
	w.byKey = make(map[string]int, len(kept))
	for i, e := range kept {
		w.byKey[e.key] = i
	}
}

// Sum returns the total notional currently inside the window.
func (w *SlidingWindow) Sum() float64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	total := 0.0
	for _, e := range w.entries {
		total += e.notional
	}
	return total
}

// Max returns the largest single notional currently inside the window, which
// says whether the 24h figure is a flow or one position.
func (w *SlidingWindow) Max() float64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	max := 0.0
	for _, e := range w.entries {
		if e.notional > max {
			max = e.notional
		}
	}
	return max
}

// NewestMs returns the timestamp of the most recent entry, or 0 when empty.
// Published as an age so a feed that has stopped reporting is visible next
// to the rate it still produces.
func (w *SlidingWindow) NewestMs() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	var newest int64
	for _, e := range w.entries {
		if e.tsMs > newest {
			newest = e.tsMs
		}
	}
	return newest
}

// Len returns the number of entries currently inside the window.
func (w *SlidingWindow) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.entries)
}

// IsWarm reports whether a full window span has elapsed since the first tick,
// i.e. whether the 24h sum is trustworthy.
func (w *SlidingWindow) IsWarm(now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return !w.firstAt.IsZero() && now.Sub(w.firstAt) >= w.span
}

// SampleWindow holds a 24h trail of point-in-time readings and answers their
// mean. Open interest is an instant, the liquidation sum is a 24h total, and
// dividing one by the other made the published rate jump with the denominator
// rather than the numerator: Gains read 343% on 2026-09-24 because its open
// interest fell from $37M to $7.3M while the numerator stood still. The
// denominator is the mean over the same 24 hours the numerator covers.
type SampleWindow struct {
	mu      sync.Mutex
	samples []windowEntry // key unused; tsMs + value
	span    time.Duration
}

// NewSampleWindow returns a sample window covering the given span.
func NewSampleWindow(span time.Duration) *SampleWindow {
	return &SampleWindow{span: span}
}

// Add records one reading and drops readings older than the span.
func (s *SampleWindow) Add(tsMs int64, value float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.samples = append(s.samples, windowEntry{tsMs: tsMs, notional: value})
	cutoff := tsMs - s.span.Milliseconds()
	kept := s.samples[:0]
	for _, e := range s.samples {
		if e.tsMs >= cutoff {
			kept = append(kept, e)
		}
	}
	for i := len(kept); i < len(s.samples); i++ {
		s.samples[i] = windowEntry{}
	}
	s.samples = kept
}

// Mean returns the arithmetic mean of the readings held, or 0 when empty.
func (s *SampleWindow) Mean() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.samples) == 0 {
		return 0
	}
	total := 0.0
	for _, e := range s.samples {
		total += e.notional
	}
	return total / float64(len(s.samples))
}

// Len returns how many readings the window holds.
func (s *SampleWindow) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.samples)
}

// SeenSet tracks deduplication keys together with the event timestamp so
// stale keys can be pruned alongside the sliding window.
type SeenSet struct {
	mu sync.Mutex
	m  map[string]int64
}

// NewSeenSet returns an empty SeenSet.
func NewSeenSet() *SeenSet {
	return &SeenSet{m: make(map[string]int64)}
}

// Add records key with its timestamp and reports whether the key was new.
func (s *SeenSet) Add(key string, tsMs int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[key]; ok {
		return false
	}
	s.m[key] = tsMs
	return true
}

// Prune deletes keys whose event timestamp is older than cutoffMs.
func (s *SeenSet) Prune(cutoffMs int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, ts := range s.m {
		if ts < cutoffMs {
			delete(s.m, k)
		}
	}
}

// Len returns the number of tracked keys.
func (s *SeenSet) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}
