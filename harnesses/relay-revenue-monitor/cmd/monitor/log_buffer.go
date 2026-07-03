package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
)

// logBuffer is an in-memory ring of the last N log lines. The harness
// duplicates stdout into the buffer so /logs?tail=N can serve recent
// activity without Railway dashboard access.
type logBuffer struct {
	mu    sync.Mutex
	lines []string
	max   int
}

var logRing *logBuffer

func installLogCapture() {
	logRing = &logBuffer{max: 5000}
	r, w, err := os.Pipe()
	if err != nil {
		fmt.Println("logbuffer: failed to install capture:", err)
		return
	}
	os.Stdout = w
	go func() {
		buf := make([]byte, 4096)
		var partial []byte
		for {
			n, err := r.Read(buf)
			if n > 0 {
				partial = append(partial, buf[:n]...)
				for {
					i := indexNL(partial)
					if i < 0 {
						break
					}
					line := string(partial[:i])
					partial = partial[i+1:]
					logRing.add(line)
					fmt.Fprintln(os.Stderr, line)
				}
			}
			if err != nil {
				if err == io.EOF {
					return
				}
				return
			}
		}
	}()
}

func indexNL(b []byte) int {
	for i, c := range b {
		if c == '\n' {
			return i
		}
	}
	return -1
}

func (lb *logBuffer) add(line string) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	lb.lines = append(lb.lines, line)
	if len(lb.lines) > lb.max {
		lb.lines = lb.lines[len(lb.lines)-lb.max:]
	}
}

func (lb *logBuffer) tail(n int) []string {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	if n <= 0 || n > len(lb.lines) {
		n = len(lb.lines)
	}
	out := make([]string, n)
	copy(out, lb.lines[len(lb.lines)-n:])
	return out
}

func setupLogsEndpoint(mux *http.ServeMux) {
	mux.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
		token := os.Getenv("LOGS_TOKEN")
		if token != "" && r.Header.Get("X-Logs-Token") != token {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("forbidden"))
			return
		}
		n := 200
		if v := r.URL.Query().Get("tail"); v != "" {
			_, _ = fmt.Sscanf(v, "%d", &n)
		}
		if logRing == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		for _, line := range logRing.tail(n) {
			_, _ = w.Write([]byte(line))
			_, _ = w.Write([]byte("\n"))
		}
	})
}
