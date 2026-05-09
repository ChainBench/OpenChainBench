package main

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// In-memory ring buffer + tee-stdout. Deliberately small so memory stays
// bounded on Railway. /logs?tail=N returns the last N lines.
const logBufferSize = 5000

var (
	logBuf   = make([]string, 0, logBufferSize)
	logBufMu sync.Mutex
)

type logTee struct {
	orig *os.File
}

func (t *logTee) Write(p []byte) (int, error) {
	logBufMu.Lock()
	line := time.Now().UTC().Format(time.RFC3339Nano) + " " + string(p)
	if len(logBuf) >= logBufferSize {
		logBuf = logBuf[1:]
	}
	logBuf = append(logBuf, line)
	logBufMu.Unlock()
	return t.orig.Write(p)
}

func installLogCapture() {
	os.Stdout = os.NewFile(uintptr(1), "stdout") // no-op but documents intent
	tee := &logTee{orig: os.Stdout}
	// Replace fmt.Println target: wrap stdout via os.Pipe is heavy; instead
	// we just redirect via a Writer wrapper for explicit logger calls.
	// fmt.Print* still goes to original stdout — the tee captures duplicates
	// when callers explicitly use logBuf.append.
	_ = tee
}

func appendLog(format string, args ...any) {
	line := time.Now().UTC().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...)
	logBufMu.Lock()
	if len(logBuf) >= logBufferSize {
		logBuf = logBuf[1:]
	}
	logBuf = append(logBuf, line)
	logBufMu.Unlock()
	fmt.Println(line)
}

func setupLogsEndpoint(mux *http.ServeMux, token string) {
	mux.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.Header.Get("X-Logs-Token") != token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		tail := 1000
		if t := r.URL.Query().Get("tail"); t != "" {
			if n, err := strconv.Atoi(t); err == nil && n > 0 && n <= logBufferSize {
				tail = n
			}
		}
		logBufMu.Lock()
		start := len(logBuf) - tail
		if start < 0 {
			start = 0
		}
		out := make([]string, len(logBuf)-start)
		copy(out, logBuf[start:])
		logBufMu.Unlock()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for _, l := range out {
			_, _ = w.Write([]byte(l))
		}
	})
}
