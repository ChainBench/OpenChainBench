package main

import (
	"fmt"
	"os"
	"sync"

	"gopkg.in/yaml.v3"
)

// promisedYieldsFile is the on-disk shape of promised-yields.yml.
// Editable by hand + versioned in the repo so every value is
// traceable to a source URL and date.
type promisedYieldsFile struct {
	Updated string           `yaml:"updated"`
	Issuers []promisedEntry  `yaml:"issuers"`
}

type promisedEntry struct {
	Token          string `yaml:"token"`
	PromisedAPYBps int    `yaml:"promised_apy_bps"`
	Source         string `yaml:"source"`
	SourceDate     string `yaml:"source_date"`
	Notes          string `yaml:"notes"`
}

// promisedStore is a thread-safe token → bps map, reloaded from
// promised-yields.yml every promisedReloadInterval. Reads are lock-
// free-fast via atomic map swap.
type promisedStore struct {
	mu   sync.RWMutex
	byToken map[string]int
	path string
}

func newPromisedStore(path string) *promisedStore {
	return &promisedStore{
		byToken: make(map[string]int),
		path:    path,
	}
}

func (s *promisedStore) get(token string) (int, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.byToken[token]
	return v, ok
}

// reload reads promised-yields.yml and swaps the internal map. Any
// parse error leaves the previous state intact so a bad edit doesn't
// zero out the metrics.
func (s *promisedStore) reload() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return fmt.Errorf("read %s: %w", s.path, err)
	}
	var parsed promisedYieldsFile
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return fmt.Errorf("unmarshal %s: %w", s.path, err)
	}
	next := make(map[string]int, len(parsed.Issuers))
	for _, e := range parsed.Issuers {
		if e.Token == "" {
			continue
		}
		next[e.Token] = e.PromisedAPYBps
	}
	s.mu.Lock()
	s.byToken = next
	s.mu.Unlock()
	return nil
}
