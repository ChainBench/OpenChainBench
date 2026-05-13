package main

import (
	"encoding/json"
	"net/http"
)

func setupFinalityDebugEndpoint(mux *http.ServeMux) {
	mux.HandleFunc("/debug/finality", func(w http.ResponseWriter, r *http.Request) {
		debugMu.Lock()
		out := make([]*FinalitySample, 0, len(debugSnapshots))
		for _, s := range debugSnapshots {
			out = append(out, s)
		}
		debugMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"snapshots": out})
	})
}
