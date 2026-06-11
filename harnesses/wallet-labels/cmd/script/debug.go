package main

import (
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"
)

// Per-provider rolling buffer of the last N raw responses, for debugging
// "did the provider really return that?" without re-querying.
const debugBufferSize = 50

type debugEntry struct {
	At          string         `json:"at"`
	Provider    string         `json:"provider"`
	Chain       string         `json:"chain"`
	Address     string         `json:"address"`
	HasLabel    bool           `json:"has_label"`
	LatencyMs   int64          `json:"latency_ms"`
	Err         string         `json:"err,omitempty"`
	Label       string         `json:"label,omitempty"`
	Raw         map[string]any `json:"raw,omitempty"`
}

var (
	debugMu  sync.Mutex
	debugBuf = make(map[string][]debugEntry)
)

func recordDebug(e debugEntry) {
	if e.At == "" {
		e.At = time.Now().UTC().Format(time.RFC3339)
	}
	debugMu.Lock()
	b := debugBuf[e.Provider]
	if len(b) >= debugBufferSize {
		b = b[1:]
	}
	debugBuf[e.Provider] = append(b, e)
	debugMu.Unlock()
}

func setupDebugEndpoint(mux *http.ServeMux) {
	expectedToken := os.Getenv("LOGS_TOKEN")
	mux.HandleFunc("/debug/wallet-labels", func(w http.ResponseWriter, r *http.Request) {
		if expectedToken == "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("X-Logs-Token") != expectedToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		debugMu.Lock()
		out := make(map[string][]debugEntry, len(debugBuf))
		for k, v := range debugBuf {
			cp := make([]debugEntry, len(v))
			copy(cp, v)
			out[k] = cp
		}
		debugMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
}
