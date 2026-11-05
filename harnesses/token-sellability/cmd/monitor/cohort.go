package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// cohortMemory decides which failed exits are worth scoring a company
// against, by watching how a token behaves over time rather than in one sweep.
//
// Three shapes, measured over 24h on 657 tokens on 2026-11-05:
//
//	546  never changed, sellable
//	 61  never changed, unsellable      scoreable
//	 39  went unsellable then came back  the instrument
//	  5  went unsellable and stayed      a real failure, and the point here
//
// Two corrections since the first version, both from the audit, and both
// because the rule was inert rather than wrong.
//
// It lived only in the process. The harness restarted ten times on the day it
// shipped, every restart emptied the map, so every token read as a first
// sighting and was scored at once. token_sellability_contradicted sat at 0 at
// every sample, which is precisely the evidence that the rule never fired,
// published by the gauge built to show it firing and never read. The state is
// now written to disk and survives a restart.
//
// And a first sighting was scored on a single observation, which is the same
// one-sample claim the rule exists to refuse. Everything now needs
// confirmation; a token simply enters the cohort one sweep later.
type cohortMemory struct {
	mu     sync.Mutex
	window time.Duration
	path   string
	state  map[string]*tokenState
}

type tokenState struct {
	Seen time.Time `json:"seen"`
	// Sold is true once this probe has completed a sale of this token inside
	// the window, at the tier being asked about.
	Sold map[string]bool `json:"sold"`
	// Run counts consecutive observations of a failed exit, per tier. A sale
	// at that tier resets it.
	Run map[string]int `json:"run"`
}

// confirmations is how many consecutive failures are needed before a token is
// scored against anyone. Two, because one is what the 39 noise cases look
// like and the 5 real ones all persisted for hours.
const confirmations = 2

func newCohortMemory(window time.Duration, dir string) *cohortMemory {
	m := &cohortMemory{window: window, state: map[string]*tokenState{}}
	if dir != "" {
		m.path = filepath.Join(dir, "cohort-state.json")
		m.load()
	}
	return m
}

func (m *cohortMemory) load() {
	b, err := os.ReadFile(m.path)
	if err != nil {
		return
	}
	var saved map[string]*tokenState
	if err := json.Unmarshal(b, &saved); err != nil {
		log.Printf("[sellability] cohort state unreadable, starting empty: %v", err)
		return
	}
	for k, v := range saved {
		if time.Since(v.Seen) < m.window {
			m.state[k] = v
		}
	}
	log.Printf("[sellability] cohort state restored: %d tokens still in the window",
		len(m.state))
}

func (m *cohortMemory) save() {
	if m.path == "" {
		return
	}
	m.mu.Lock()
	b, err := json.Marshal(m.state)
	m.mu.Unlock()
	if err != nil {
		return
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		log.Printf("[sellability] cohort state write: %v", err)
		return
	}
	// Renamed into place, so a restart during a write cannot leave half a
	// file that reads as empty state. Starting from nothing is the exact
	// failure this file exists to stop.
	if err := os.Rename(tmp, m.path); err != nil {
		log.Printf("[sellability] cohort state rename: %v", err)
	}
}

// Observe records what this sweep found, per tier.
//
// Per tier, not "sold at either timing", because the old shape contradicted
// the bench's own premise. A token blocked in the same block and fine a few
// blocks later is exactly the anti-bot cooldown the two timings exist to
// separate, and marking it sold erased it from the same-block cohort where it
// belonged. The two tabs then agreed on 1000 of 1000 ledger rows, which is
// what a selector measuring nothing looks like.
func (m *cohortMemory) Observe(token, tier string, sellable bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.state[token]
	if !ok {
		s = &tokenState{Sold: map[string]bool{}, Run: map[string]int{}}
		m.state[token] = s
	}
	if s.Sold == nil {
		s.Sold = map[string]bool{}
	}
	if s.Run == nil {
		s.Run = map[string]int{}
	}
	s.Seen = time.Now()
	if sellable {
		s.Sold[tier] = true
		s.Run[tier] = 0
		return
	}
	s.Run[tier]++
}

// Scoreable reports whether a failed exit on this token, at this tier, may be
// counted against an aggregator. Everything needs two consecutive failures,
// a token we have never sold included: one observation is one sample, and one
// sample is what this rule exists to refuse.
func (m *cohortMemory) Scoreable(token, tier string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.state[token]
	return ok && s.Run[tier] >= confirmations
}

// Provisional reports a failure being held pending confirmation, as opposed
// to a token that is simply fine. The board should be able to tell them apart.
func (m *cohortMemory) Provisional(token, tier string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.state[token]
	return ok && s.Run[tier] > 0 && s.Run[tier] < confirmations
}

// Prune drops tokens that left the window, writes the state out and returns
// how many are tracked, so the size of this memory is visible in the sweep
// log rather than growing unseen.
func (m *cohortMemory) Prune() int {
	m.mu.Lock()
	for t, s := range m.state {
		if time.Since(s.Seen) >= m.window {
			delete(m.state, t)
		}
	}
	n := len(m.state)
	m.mu.Unlock()
	m.save()
	return n
}
