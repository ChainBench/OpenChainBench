package main

import (
	"encoding/json"
	"net/http"
	"os"
	"sort"
)

type debugResp struct {
	Snapshots []PerpSample `json:"snapshots"`
}

func setupDebugEndpoint(mux *http.ServeMux) {
	expectedToken := os.Getenv("LOGS_TOKEN")
	mux.HandleFunc("/debug/perp", func(w http.ResponseWriter, r *http.Request) {
		if expectedToken == "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("X-Logs-Token") != expectedToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		debugMu.Lock()
		out := make([]PerpSample, 0, len(debugSnapshots))
		for _, s := range debugSnapshots {
			out = append(out, *s)
		}
		debugMu.Unlock()
		sort.Slice(out, func(i, j int) bool {
			if out[i].Venue != out[j].Venue {
				return out[i].Venue < out[j].Venue
			}
			return out[i].Asset < out[j].Asset
		})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(debugResp{Snapshots: out})
	})
}
