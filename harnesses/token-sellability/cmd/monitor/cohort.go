package main

import (
	"sync"
	"time"
)

// cohortMemory decides which unsellable verdicts are worth scoring a company
// against, by watching how a token behaves over time rather than in one sweep.
//
// Three shapes, measured over 24h on 657 tokens on 2026-11-05:
//
//	546  never changed, sellable
//	 61  never changed, unsellable      <- scoreable immediately
//	 39  went unsellable then came back <- the instrument, never scoreable
//	  5  went unsellable and stayed     <- a rug, and the point of the bench
//
// The first version of this file excluded anything carrying both verdicts,
// which correctly removed the 39 and wrongly removed the 5. Those 5 are the
// events this bench exists to catch, so the separator cannot be "has
// contradicted itself" but "did the failure persist".
//
// Persistence is only knowable afterwards, so an unsellable verdict on a
// token we have sold is held as provisional and counts only once a later
// sweep agrees with no sale in between. A token we have never sold is scored
// at once: there is nothing to contradict.
type cohortMemory struct {
	mu     sync.Mutex
	window time.Duration
	state  map[string]*tokenState
}

type tokenState struct {
	seen time.Time
	// sold is true once this probe has completed a sale of this token inside
	// the window. It is what makes a later failure provisional.
	sold bool
	// run counts consecutive observations of a failed sale. Any sale resets
	// it, because a sale means the token was fine at that moment and whatever
	// came before is not a trend.
	run int
}

// confirmations is how many consecutive failures are needed before a token we
// have previously sold is scored against anyone. Two, because one is what the
// 39 noise cases look like and the 5 real ones all persisted for hours.
const confirmations = 2

func newCohortMemory(window time.Duration) *cohortMemory {
	return &cohortMemory{window: window, state: map[string]*tokenState{}}
}

// Observe records what this sweep found. sellable is true when the token sold
// at either timing.
func (m *cohortMemory) Observe(token string, sellable bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.state[token]
	if !ok {
		s = &tokenState{}
		m.state[token] = s
	}
	s.seen = time.Now()
	if sellable {
		s.sold = true
		s.run = 0
		return
	}
	s.run++
}

// Scoreable reports whether a failed sale on this token may be counted
// against an aggregator.
func (m *cohortMemory) Scoreable(token string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.state[token]
	if !ok {
		// Not observed this window. Nothing says it is unreliable, but
		// nothing says it is confirmed either; treat the current sweep's
		// failure as the first observation.
		return false
	}
	if !s.sold {
		return s.run >= 1
	}
	return s.run >= confirmations
}

// Provisional reports a token whose failure is being held pending
// confirmation, as opposed to one that is simply fine. The two are different
// and the board should be able to tell them apart.
func (m *cohortMemory) Provisional(token string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.state[token]
	return ok && s.sold && s.run > 0 && s.run < confirmations
}

// Prune drops tokens that left the window and returns how many are tracked,
// so the size of this memory is visible in the sweep log rather than growing
// unseen for the life of the process.
func (m *cohortMemory) Prune() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	for t, s := range m.state {
		if time.Since(s.seen) >= m.window {
			delete(m.state, t)
		}
	}
	return len(m.state)
}
