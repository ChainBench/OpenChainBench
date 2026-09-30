package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// A detected fee-basis shift has to outlive the tick that found it. The
// seam between two measurements sits in the prior 30-day window for up to
// a month after it stops affecting the current one, and the detection
// itself weakens day by day as the prior window fills back up with the
// new basis. Reading the detection fresh on every tick therefore clears
// the flag within days while the trend it protects against is still
// inflated (review of PR 2695).
//
// So the harness remembers, keyed by slug, when it last saw a shift, and
// keeps withholding that row's trend for feeBasisMemory. The memory is a
// small JSON file so a redeploy does not forget: without a writable path
// the harness still runs, it just forgets on restart, which is the state
// this file exists to improve on rather than a failure.
type feeBasisMemoryStore struct {
	mu   sync.Mutex
	path string
	seen map[string]int64 // slug -> unix seconds of the last detection
	warn bool             // a write failed once; do not repeat the log every tick
}

func newFeeBasisMemory(path string) *feeBasisMemoryStore {
	m := &feeBasisMemoryStore{path: path, seen: map[string]int64{}}
	if path == "" {
		return m
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Printf("[basis] cannot read %s: %v (starting empty)\n", path, err)
		}
		return m
	}
	var onDisk map[string]int64
	if err := json.Unmarshal(b, &onDisk); err != nil {
		fmt.Printf("[basis] %s is not readable json: %v (starting empty)\n", path, err)
		return m
	}
	m.seen = onDisk
	return m
}

// apply records the shifts this tick found, then sets the flag on every
// row whose last detection is still inside the memory window. Returns how
// many rows carry the flag, new and remembered together.
func (m *feeBasisMemoryStore) apply(cohort []Protocol, now time.Time) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := now.Add(-feeBasisMemory).Unix()
	for i := range cohort {
		if cohort[i].FeeBasisShift {
			m.seen[cohort[i].GeckoID] = now.Unix()
		}
	}
	// Forget the ones whose window has passed, so the file stays small and
	// a row that settled years ago is not withheld forever.
	for slug, at := range m.seen {
		if at < cutoff {
			delete(m.seen, slug)
		}
	}
	flagged := 0
	for i := range cohort {
		if at, ok := m.seen[cohort[i].GeckoID]; ok && at >= cutoff {
			cohort[i].FeeBasisShift = true
			flagged++
		}
	}
	m.save()
	return flagged
}

// save writes through a temp file in the same directory, so a crash
// mid-write leaves the previous memory rather than a truncated one.
func (m *feeBasisMemoryStore) save() {
	if m.path == "" {
		return
	}
	b, err := json.Marshal(m.seen)
	if err != nil {
		return
	}
	dir := filepath.Dir(m.path)
	tmp, err := os.CreateTemp(dir, ".fee-basis-*.json")
	if err != nil {
		if !m.warn {
			fmt.Printf("[basis] cannot write %s: %v (memory is in-process only)\n", m.path, err)
			m.warn = true
		}
		return
	}
	name := tmp.Name()
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(name)
		return
	}
	if err := os.Rename(name, m.path); err != nil {
		os.Remove(name)
		if !m.warn {
			fmt.Printf("[basis] cannot replace %s: %v (memory is in-process only)\n", m.path, err)
			m.warn = true
		}
	}
}
