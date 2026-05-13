package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

type providerSnapshot struct {
	Provider     string    `json:"provider"`
	At           string    `json:"at"`
	LatencyMs    int64     `json:"latency_ms"`
	NetworkCount int       `json:"network_count"`
	Error        string    `json:"error,omitempty"`
	Sample       []Network `json:"sample,omitempty"`     // first 5 networks
	RawSample    string    `json:"raw_sample,omitempty"` // first 400 chars of raw response
}

var (
	debugMu        sync.Mutex
	debugSnapshots = map[string]*providerSnapshot{}
)

func recordDebugSnapshot(provider string, res ProviderResult, dur time.Duration) {
	snap := &providerSnapshot{
		Provider:     provider,
		At:           time.Now().UTC().Format(time.RFC3339),
		LatencyMs:    dur.Milliseconds(),
		NetworkCount: len(res.Networks),
		Error:        res.Err,
	}
	if len(res.Networks) > 5 {
		snap.Sample = res.Networks[:5]
	} else {
		snap.Sample = res.Networks
	}
	debugMu.Lock()
	debugSnapshots[provider] = snap
	debugMu.Unlock()
}

func recordDebugRaw(provider, body string) {
	debugMu.Lock()
	defer debugMu.Unlock()
	if s, ok := debugSnapshots[provider]; ok {
		if len(body) > 400 {
			s.RawSample = body[:400]
		} else {
			s.RawSample = body
		}
	}
}

func setupNetworksDebugEndpoint(mux *http.ServeMux) {
	mux.HandleFunc("/debug/networks", func(w http.ResponseWriter, r *http.Request) {
		debugMu.Lock()
		out := make([]*providerSnapshot, 0, len(debugSnapshots))
		for _, s := range debugSnapshots {
			out = append(out, s)
		}
		debugMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"snapshots": out})
	})
}
