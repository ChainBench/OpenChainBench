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

// Inlined per-harness so Railway Docker build context need not reach a shared
// module. Captures stdout/stderr into a bounded ring buffer and exposes
// GET /logs?tail=N protected by X-Logs-Token matching the LOGS_TOKEN env var.

const logRingMax = 5000

type logRing struct {
	mu    sync.Mutex
	lines []string
	max   int
}

var globalLogRing = &logRing{max: logRingMax}

func (b *logRing) push(line string) {
	entry := time.Now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + line
	b.mu.Lock()
	if len(b.lines) >= b.max {
		b.lines = append(b.lines[1:], entry)
	} else {
		b.lines = append(b.lines, entry)
	}
	b.mu.Unlock()
}

func (b *logRing) snapshot(tail int) []string {
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

var logSetupOnce sync.Once

func installLogCapture() { logSetupOnce.Do(doInstallLogCapture) }

func doInstallLogCapture() {
	originalStdout := os.Stdout
	originalStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		fmt.Fprintf(originalStdout, "[loghub] pipe failed: %v (/logs will be empty)\n", err)
		return
	}
	os.Stdout = w
	os.Stderr = w

	go func() {
		scanner := bufio.NewScanner(r)
		buf := make([]byte, 0, 1024*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(originalStdout, line)
			globalLogRing.push(line)
		}
		_, _ = io.Copy(originalStdout, r)
		_ = originalStderr
	}()
}

func logsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := os.Getenv("LOGS_TOKEN")
		if expected == "" {
			http.Error(w, "logs disabled: LOGS_TOKEN unset", http.StatusForbidden)
			return
		}
		if r.Header.Get("X-Logs-Token") != expected {
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
		for _, l := range globalLogRing.snapshot(tail) {
			fmt.Fprintln(w, l)
		}
	})
}
