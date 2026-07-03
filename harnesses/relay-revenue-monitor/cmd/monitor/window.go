package main

import (
	"sync"
	"time"
)

// Window stores balance snapshots. Each snapshot is (timestamp,
// total_usd, stable_usd). Delta over window = balance[now] - balance[now
// - window]. The "now" sample is the most recent snapshot; the "older"
// sample is the closest one to the cutoff (last sample whose ts <= now
// - window).
//
// All in-memory. Restart wipes history; the 24h delta needs 24h of
// runtime to populate cleanly. The same trade-off every other OCB
// harness with histograms / counters takes.
type Window struct {
	mu       sync.Mutex
	snapshots []snapshot
}

type snapshot struct {
	ts     time.Time
	total  float64
	stable float64
}

func NewWindow() *Window {
	return &Window{snapshots: make([]snapshot, 0, 1024)}
}

// Add records a balance snapshot at time ts.
func (w *Window) Add(ts time.Time, total, stable float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.snapshots = append(w.snapshots, snapshot{ts: ts, total: total, stable: stable})
}

// Delta returns (total_delta_usd, stable_delta_usd) over the trailing
// window ending at now. Returns (0, 0) if we don't yet have a snapshot
// older than (now - window).
func (w *Window) Delta(now time.Time, window time.Duration) (float64, float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.snapshots) < 2 {
		return 0, 0
	}
	latest := w.snapshots[len(w.snapshots)-1]
	cutoff := now.Add(-window)
	var older *snapshot
	for i := range w.snapshots {
		if w.snapshots[i].ts.After(cutoff) {
			break
		}
		s := w.snapshots[i]
		older = &s
	}
	if older == nil {
		return 0, 0
	}
	return latest.total - older.total, latest.stable - older.stable
}

// Prune drops snapshots older than maxAge to bound memory growth.
func (w *Window) Prune(now time.Time, maxAge time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	cutoff := now.Add(-maxAge)
	keep := w.snapshots[:0]
	for _, s := range w.snapshots {
		if s.ts.After(cutoff) {
			keep = append(keep, s)
		}
	}
	w.snapshots = keep
}

// Count returns the number of snapshots currently stored (diagnostic).
func (w *Window) Count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.snapshots)
}
