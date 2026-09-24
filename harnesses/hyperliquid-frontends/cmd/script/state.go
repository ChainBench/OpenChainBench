package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// dayTotals is the per (builder slug, UTC day) row of the persisted ledger:
// enough to compute biggest day, revenue milestones and period-over-period
// deltas without keeping the raw CSVs beyond the 30-day mirror.
type dayTotals struct {
	Fees  float64 `json:"f"`
	Vol   float64 `json:"v"`
	Fills int     `json:"n"`
	Users int     `json:"u"`
}

// State is the JSON file that survives restarts. Days are "YYYYMMDD".
type State struct {
	Version int `json:"version"`
	// Ledger[slug][day]. Days inside the mirror window are overwritten from
	// the mirror on every publish; older days come from the one-off ledger
	// backfill and are never touched again.
	Ledger map[string]map[string]dayTotals `json:"ledger"`
	// Days for which every registry address was fetched (200 or 403) by the
	// ledger backfill. Milestones and the biggest day publish only once the
	// whole [ledger-from, window start) range is complete.
	LedgerComplete map[string]bool `json:"ledger_complete"`
	// Hip3Daily[dex][day] = the dex's 24h notional as sampled by the first
	// poll of day+1 (so the sample covers roughly that UTC day).
	Hip3Daily map[string]map[string]float64 `json:"hip3_daily"`
	// DataDay is the last complete feed day the gauges were published for.
	DataDay string `json:"data_day"`

	mu   sync.Mutex
	path string
}

func loadState(path string) (*State, error) {
	s := &State{Version: 2, path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			s.init()
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(raw, s); err != nil {
		return nil, err
	}
	s.init()
	return s, nil
}

func (s *State) init() {
	if s.Ledger == nil {
		s.Ledger = make(map[string]map[string]dayTotals)
	}
	if s.LedgerComplete == nil {
		s.LedgerComplete = make(map[string]bool)
	}
	if s.Hip3Daily == nil {
		s.Hip3Daily = make(map[string]map[string]float64)
	}
	s.Version = 2
}

func (s *State) save() error {
	s.mu.Lock()
	raw, err := json.Marshal(s)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *State) setLedger(slug, day string, t dayTotals) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.Ledger[slug]
	if !ok {
		m = make(map[string]dayTotals)
		s.Ledger[slug] = m
	}
	m[day] = t
}

func (s *State) ledgerFor(slug string) map[string]dayTotals {
	s.mu.Lock()
	defer s.mu.Unlock()
	src := s.Ledger[slug]
	out := make(map[string]dayTotals, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

// ledgerDaysSorted returns the ledger days of one builder, ascending.
func ledgerDaysSorted(m map[string]dayTotals) []string {
	days := make([]string, 0, len(m))
	for d := range m {
		days = append(days, d)
	}
	sort.Strings(days)
	return days
}

func (s *State) markComplete(day string) {
	s.mu.Lock()
	s.LedgerComplete[day] = true
	s.mu.Unlock()
}

func (s *State) isComplete(day string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.LedgerComplete[day]
}

func (s *State) setHip3Daily(dex, day string, vol float64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.Hip3Daily[dex]
	if !ok {
		m = make(map[string]float64)
		s.Hip3Daily[dex] = m
	}
	if _, exists := m[day]; exists {
		return false
	}
	m[day] = vol
	return true
}

func (s *State) hip3DailyFor(dex string) map[string]float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	src := s.Hip3Daily[dex]
	out := make(map[string]float64, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

func (s *State) setDataDay(day string) {
	s.mu.Lock()
	s.DataDay = day
	s.mu.Unlock()
}
