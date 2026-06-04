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
type logBuffer struct {
	mu    sync.Mutex
	lines []string
	max   int
}

const logBufferMax = 5000

var globalLogBuffer = &logBuffer{max: logBufferMax}

func (b *logBuffer) push(line string) {
	entry := time.Now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + line
	b.mu.Lock()
	if len(b.lines) >= b.max {
		b.lines = append(b.lines[1:], entry)
	} else {
		b.lines = append(b.lines, entry)
	}
	b.mu.Unlock()
}

func (b *logBuffer) Snapshot(tail int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if tail <= 0 || tail >= len(b.lines) {
		out := make([]string, len(b.lines))
		copy(out, b.lines)
		return out
	}
	start := len(b.lines) - tail
	out := make([]string, tail)
	copy(out, b.lines[start:])
	return out
}

// installLogCapture replaces os.Stdout with the write-end of a pipe, then
// spawns a goroutine that fan-outs every line to the real stdout AND the
// in-memory ring buffer. This catches fmt.Println/Printf as well as log.Printf.
//
// Call exactly once, very early in main().
func installLogCapture() {
	originalStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		// Fallback: don't intercept. /logs will be empty but everything else still works.
		fmt.Fprintf(originalStdout, "[log_buffer] failed to create pipe: %v (logs endpoint will be empty)\n", err)
		return
	}
	os.Stdout = w

	go func() {
		scanner := bufio.NewScanner(r)
		// Allow long lines (default is 64KB, bump to 1MB for safety)
		buf := make([]byte, 0, 1024*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(originalStdout, line)
			globalLogBuffer.push(line)
		}
		// Pipe closed (process shutdown) — drain anything left
		_, _ = io.Copy(originalStdout, r)
	}()
}

// setupLogsEndpoint exposes GET /logs?tail=N (default 500, max logBufferMax).
// If LOGS_TOKEN env var is set, requires header `X-Logs-Token` to match.
// Otherwise the endpoint is open — only safe for Railway-internal access.
func setupLogsEndpoint(mux *http.ServeMux) {
	expectedToken := os.Getenv("LOGS_TOKEN")
	mux.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
		if expectedToken != "" && r.Header.Get("X-Logs-Token") != expectedToken {
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
