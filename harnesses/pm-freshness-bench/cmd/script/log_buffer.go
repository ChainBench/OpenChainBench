package main

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Ring buffer mirroring the pattern used in the aggregator-latency-benchmark
// and wallet-labels miniapps. Captures the last ~5000 log lines for the
// `/logs?tail=N` endpoint.
const ringCapacity = 5000

type logEntry struct {
	At   time.Time
	Line string
}

var (
	ringMu sync.Mutex
	ring   = make([]logEntry, 0, ringCapacity)
)

func appendLog(format string, args ...interface{}) {
	line := fmt.Sprintf(format, args...)
	ts := time.Now().UTC().Format("15:04:05.000")
	fmt.Printf("[%s] %s\n", ts, line)
	ringMu.Lock()
	if len(ring) >= ringCapacity {
		ring = ring[1:]
	}
	ring = append(ring, logEntry{At: time.Now(), Line: line})
	ringMu.Unlock()
}

func setupLogsEndpoint(mux *http.ServeMux, token string) {
	mux.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.Header.Get("X-Logs-Token") != token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		tail := 200
		if q := r.URL.Query().Get("tail"); q != "" {
			fmt.Sscanf(q, "%d", &tail)
		}
		ringMu.Lock()
		defer ringMu.Unlock()
		start := 0
		if len(ring) > tail {
			start = len(ring) - tail
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for _, e := range ring[start:] {
			fmt.Fprintf(w, "[%s] %s\n", e.At.UTC().Format("15:04:05.000"), e.Line)
		}
	})
}
