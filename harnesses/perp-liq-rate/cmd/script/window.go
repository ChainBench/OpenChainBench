package main

// window.go — thread-safe 24h sliding window of liquidation notionals plus
// the dedup SeenSet that is pruned alongside it.

import (
	"sync"
	"time"
)

type windowEntry struct {
	tsMs     int64
	notional float64
}

// SlidingWindow accumulates (unix_ms, notional_usd) events and answers the
// rolling sum over its span. All methods are safe for concurrent use.
type SlidingWindow struct {
	mu      sync.Mutex
	entries []windowEntry
	span    time.Duration
	firstAt time.Time // wall time of the first tick that touched this window
}

// NewSlidingWindow returns a window covering the given span (24h here).
func NewSlidingWindow(span time.Duration) *SlidingWindow {
	return &SlidingWindow{span: span}
}

// Add appends one event to the window.
func (w *SlidingWindow) Add(tsMs int64, notionalUSD float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.entries = append(w.entries, windowEntry{tsMs: tsMs, notional: notionalUSD})
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

// Len returns the number of events currently inside the window.
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
