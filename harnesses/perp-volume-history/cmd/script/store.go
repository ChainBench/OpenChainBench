package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Store is the on-disk history: venue -> day -> point. One JSON file,
// written atomically (temp + rename) after every sweep. A few hundred
// venues x days is well under a megabyte, so a flat file beats a DB
// dependency here; hl-archive needs DuckDB because it folds millions of
// fills, this harness stores one number per venue per day.
type Store struct {
	mu     sync.RWMutex
	path   string
	dirty  bool
	Venues map[string]map[string]Point `json:"venues"`
}

// Point is one UTC day of one venue. Source names which upstream wrote
// it so a DeFiLlama Pro point and a squid point are distinguishable in
// the history file and the public JSON.
type Point struct {
	USD    float64 `json:"usd"`
	Source string  `json:"source"`
}

func openStore(path string) (*Store, error) {
	s := &Store{path: path, Venues: map[string]map[string]Point{}}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return nil, err
			}
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if s.Venues == nil {
		s.Venues = map[string]map[string]Point{}
	}
	return s, nil
}

func (s *Store) set(venue string, day time.Time, usd float64, source string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.Venues[venue]
	if m == nil {
		m = map[string]Point{}
		s.Venues[venue] = m
	}
	k := fmtDay(day)
	if p, ok := m[k]; ok && p.USD == usd && p.Source == source {
		return
	}
	m[k] = Point{USD: usd, Source: source}
	s.dirty = true
}

func (s *Store) get(venue string, day time.Time) (float64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.Venues[venue][fmtDay(day)]
	return p.USD, ok
}

// sum adds the days from..to inclusive and reports how many were
// present, so callers can refuse to publish a short window.
func (s *Store) sum(venue string, from, to time.Time) (float64, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := s.Venues[venue]
	var total float64
	n := 0
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		if p, ok := m[fmtDay(d)]; ok {
			total += p.USD
			n++
		}
	}
	return total, n
}

func (s *Store) days(venue string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.Venues[venue])
}

func (s *Store) oldest(venue string) (time.Time, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var best string
	for k := range s.Venues[venue] {
		if best == "" || k < best {
			best = k
		}
	}
	if best == "" {
		return time.Time{}, false
	}
	t, err := parseDay(best)
	return t, err == nil
}

func (s *Store) venueCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.Venues)
}

func (s *Store) pointCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, m := range s.Venues {
		n += len(m)
	}
	return n
}

func (s *Store) flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty {
		return nil
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := writeAtomic(s.path, b); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

// PublicDoc is the JSON the site reads. Days are sorted ascending and
// every venue carries its display name and the source that produced
// each point, so the compare page can footnote the methodology per side.
type PublicDoc struct {
	GeneratedAt string        `json:"generated_at"`
	LastClosed  string        `json:"last_closed_day"`
	Venues      []PublicVenue `json:"venues"`
}

type PublicVenue struct {
	Slug   string        `json:"slug"`
	Name   string        `json:"name"`
	Source string        `json:"source"`
	Note   string        `json:"note,omitempty"`
	Days   []PublicPoint `json:"days"`
}

type PublicPoint struct {
	Day    string  `json:"day"`
	USD    float64 `json:"usd"`
	Source string  `json:"source,omitempty"`
}

func (s *Store) publicDoc(sources []Source) PublicDoc {
	s.mu.RLock()
	defer s.mu.RUnlock()
	doc := PublicDoc{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		LastClosed:  fmtDay(utcDay(time.Now()).AddDate(0, 0, -1)),
	}
	for _, src := range sources {
		m := s.Venues[src.Slug()]
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		pv := PublicVenue{Slug: src.Slug(), Name: src.DisplayName(), Source: src.Name(), Note: src.Note(), Days: []PublicPoint{}}
		for _, k := range keys {
			p := m[k]
			pp := PublicPoint{Day: k, USD: p.USD}
			if p.Source != src.Name() {
				pp.Source = p.Source
			}
			pv.Days = append(pv.Days, pp)
		}
		doc.Venues = append(doc.Venues, pv)
	}
	return doc
}

func (s *Store) writePublic(path string, sources []Source) error {
	b, err := json.Marshal(s.publicDoc(sources))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return writeAtomic(path, b)
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
