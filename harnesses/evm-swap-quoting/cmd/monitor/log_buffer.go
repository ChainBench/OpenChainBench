package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// logBuffer keeps the last N log lines in memory for debug fetching via /logs.
// Captures BOTH log.* and fmt.Print* output (stdout is dup'd via a pipe).
//
// Implementation: fixed-size circular buffer. `head` points at the next slot
// to write; once `filled` is true every overwrite is O(1) instead of the O(n)
// slice-shift the prior version used.
type logBuffer struct {
	mu     sync.Mutex
	lines  []string
	max    int
	head   int  // next write index
	filled bool // wrapped at least once
}

const logBufferMax = 5000

var globalLogBuffer = &logBuffer{lines: make([]string, logBufferMax), max: logBufferMax}

func (b *logBuffer) push(line string) {
	entry := time.Now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + line
	b.mu.Lock()
	b.lines[b.head] = entry
	b.head++
	if b.head >= b.max {
		b.head = 0
		b.filled = true
	}
	b.mu.Unlock()
}

func (b *logBuffer) Snapshot(tail int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	size := b.head
	if b.filled {
		size = b.max
	}
	if tail <= 0 || tail >= size {
		tail = size
	}
	out := make([]string, 0, tail)
	// Walk back `tail` slots from head-1 (modular).
	for i := 0; i < tail; i++ {
		idx := (b.head - tail + i + b.max) % b.max
		out = append(out, b.lines[idx])
	}
	return out
}

// installLogCapture replaces os.Stdout with the write-end of a pipe, then
// spawns a goroutine that fan-outs every line to the real stdout AND the
// in-memory ring buffer. Catches fmt.Println/Printf as well as log.Printf.
// Call exactly once, very early in main().
func installLogCapture() {
	originalStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		fmt.Fprintf(originalStdout, "[log_buffer] failed to create pipe: %v (logs endpoint will be empty)\n", err)
		return
	}
	os.Stdout = w

	go func() {
		scanner := bufio.NewScanner(r)
		buf := make([]byte, 0, 1024*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(originalStdout, line)
			globalLogBuffer.push(line)
		}
		_, _ = io.Copy(originalStdout, r)
	}()
}

// setupLogsEndpoint exposes GET /logs?tail=N (default 500, max logBufferMax).
// Fail-secure: when LOGS_TOKEN env var is not set, returns 404.
func setupLogsEndpoint(mux *http.ServeMux) {
	expectedToken := os.Getenv("LOGS_TOKEN")
	mux.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
		if expectedToken == "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("X-Logs-Token") != expectedToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		tail := 500
		if t := r.URL.Query().Get("tail"); t != "" {
			if n, err := strconv.Atoi(t); err == nil && n > 0 {
				tail = n
			}
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for _, l := range globalLogBuffer.Snapshot(tail) {
			fmt.Fprintln(w, l)
		}
	})
}
