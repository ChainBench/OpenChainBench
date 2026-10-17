package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Last-execution times survive restarts.
//
// bridge_last_execution_timestamp_seconds is the site's freshness source
// for the execution benches (a pulse gauge cannot be, it is gone between
// runs). A gauge lives in the process, so a restart would leave the site
// reading "no run recorded" until the next 10:00 UTC cycle. The times are
// persisted next to the spend state and re-exposed at start.

type lastExecStore struct {
	mu   sync.Mutex
	path string
	ts   map[string]int64 // bridge -> unix seconds
}

func lastExecPath() string {
	return filepath.Join(filepath.Dir(spendStatePath()), "last-execution.json")
}

func newLastExecStore(path string) *lastExecStore {
	s := &lastExecStore{path: path, ts: map[string]int64{}}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &s.ts)
	}
	return s
}

// expose re-publishes every stored time on the gauge (start-up).
func (s *lastExecStore) expose(region string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for bridge, t := range s.ts {
		bridgeLastExecutionTs.WithLabelValues(bridge, region).Set(float64(t))
	}
	if len(s.ts) > 0 {
		log.Printf("⏱  last execution times restored for %d bridge(s) from %s", len(s.ts), s.path)
	}
}

// record stores and publishes the time of a terminal execution.
func (s *lastExecStore) record(bridge, region string, t time.Time) {
	bridgeLastExecutionTs.WithLabelValues(bridge, region).Set(float64(t.Unix()))
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ts[bridge] = t.Unix()
	raw, err := json.Marshal(s.ts)
	if err != nil {
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, s.path)
}
