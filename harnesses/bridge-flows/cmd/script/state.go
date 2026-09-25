package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// State persists per source chain the last scanned block and hourly
// buckets of USDC burned per destination domain, so a restart resumes at
// the cursor instead of rescanning a week of logs on public RPCs.
type State struct {
	Version int                    `json:"version"`
	Chains  map[string]*chainState `json:"chains"`

	mu   sync.Mutex
	path string
}

type chainState struct {
	Cursor int64 `json:"cursor"`
	// Hours[hourUnix][destDomain] = {usd, burns}
	Hours map[string]map[string]*bucket `json:"hours"`
}

type bucket struct {
	USD   float64 `json:"usd"`
	Burns int     `json:"n"`
}

func loadState(path string) (*State, error) {
	s := &State{Version: 1, Chains: map[string]*chainState{}, path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(raw, s); err != nil {
		return nil, err
	}
	if s.Chains == nil {
		s.Chains = map[string]*chainState{}
	}
	return s, nil
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
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "state-*.json.tmp")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

func (s *State) chain(slug string) *chainState {
	c, ok := s.Chains[slug]
	if !ok {
		c = &chainState{Hours: map[string]map[string]*bucket{}}
		s.Chains[slug] = c
	}
	if c.Hours == nil {
		c.Hours = map[string]map[string]*bucket{}
	}
	return c
}

func (s *State) cursor(slug string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.chain(slug).Cursor
}

func (s *State) setCursor(slug string, n int64) {
	s.mu.Lock()
	s.chain(slug).Cursor = n
	s.mu.Unlock()
}

func hourKey(ts int64) string { return strconv.FormatInt(ts-ts%3600, 10) }

// folded is one decoded burn ready for its bucket.
type folded struct {
	ts   int64
	dest uint32
	usd  float64
}

// addChunk folds a whole chunk's burns and advances the cursor under one
// lock, so a save can never capture the buckets without the cursor (which
// would count the chunk twice after a restart).
func (s *State) addChunk(slug string, items []folded, cursor int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range items {
		s.addLocked(slug, it.ts, it.dest, it.usd)
	}
	s.chain(slug).Cursor = cursor
}

func (s *State) add(slug string, ts int64, dest uint32, usd float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.addLocked(slug, ts, dest, usd)
}

func (s *State) addLocked(slug string, ts int64, dest uint32, usd float64) {
	c := s.chain(slug)
	h := hourKey(ts)
	m, ok := c.Hours[h]
	if !ok {
		m = map[string]*bucket{}
		c.Hours[h] = m
	}
	d := strconv.FormatUint(uint64(dest), 10)
	b, ok := m[d]
	if !ok {
		b = &bucket{}
		m[d] = b
	}
	b.USD += usd
	b.Burns++
}

// prune drops hourly buckets older than keepHours.
func (s *State) prune(slug string, keepHours int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cut := time.Now().Unix() - int64(keepHours)*3600
	c := s.chain(slug)
	for h := range c.Hours {
		if t, err := strconv.ParseInt(h, 10, 64); err == nil && t < cut {
			delete(c.Hours, h)
		}
	}
}

// window sums a chain's buckets whose hour starts within the last `d`
// (bucket hour >= now - d, so the current partial hour is included).
// Returns usd and burns per destination domain.
func (s *State) window(slug string, d time.Duration) (map[uint32]float64, map[uint32]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	usd := map[uint32]float64{}
	burns := map[uint32]int{}
	cut := time.Now().Add(-d).Unix()
	cut -= cut % 3600
	c := s.chain(slug)
	for h, m := range c.Hours {
		t, err := strconv.ParseInt(h, 10, 64)
		if err != nil || t < cut {
			continue
		}
		for d, b := range m {
			dom, err := strconv.ParseUint(d, 10, 32)
			if err != nil {
				continue
			}
			usd[uint32(dom)] += b.USD
			burns[uint32(dom)] += b.Burns
		}
	}
	return usd, burns
}

func nowUnix() int64 { return time.Now().Unix() }
