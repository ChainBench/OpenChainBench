package main

import (
	"sync"
	"time"
)

// sellableMemory remembers which tokens have been sold inside the window.
//
// Why this exists. A token that genuinely cannot be sold does not become
// sellable an hour later, so a token carrying both verdicts in one window was
// measured wrong at least once. On 2026-11-05 that was 31 of the 94 tokens in
// the unsellable cohort, a third of it, identically at both tiers. The chain's
// own wrapped ether was among them: three different verdicts in a day, and 65
// replays afterwards could not make it fail once.
//
// The control token already guards against a sweep that is entirely broken: it
// runs first and a failure discards everything. It cannot see an intermittent
// failure on one token inside an otherwise healthy sweep, which is exactly
// what this is.
//
// So the rule: a token observed sellable inside the window is not scored
// against anyone, even on a later sweep that says otherwise. It is the same
// principle as the control, applied per token. We would rather miss a real
// trap than publish a company's name against a verdict our own instrument
// contradicted.
type sellableMemory struct {
	mu     sync.Mutex
	window time.Duration
	seen   map[string]time.Time
}

func newSellableMemory(window time.Duration) *sellableMemory {
	return &sellableMemory{window: window, seen: map[string]time.Time{}}
}

// Record notes that this token sold at some tier.
func (m *sellableMemory) Record(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seen[token] = time.Now()
}

// Contradicted reports whether this token has been sold recently enough that
// an unsellable verdict on it cannot be trusted.
func (m *sellableMemory) Contradicted(token string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	at, ok := m.seen[token]
	return ok && time.Since(at) < m.window
}

// Prune drops tokens that left the window, so the map tracks the cohort
// rather than growing for the life of the process.
func (m *sellableMemory) Prune() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	for t, at := range m.seen {
		if time.Since(at) >= m.window {
			delete(m.seen, t)
		}
	}
	return len(m.seen)
}
