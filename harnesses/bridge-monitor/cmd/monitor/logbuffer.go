package main

import (
	"bytes"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// LogBuffer is an io.Writer that mirrors writes to a chained writer (stdout)
// while keeping the last `size` log lines in a ring buffer for HTTP exposure
// via /logs.
//
// Stdout writes are async via a buffered channel + drain goroutine. If the
// channel saturates (Railway log collector wedged → OS pipe full → write(2)
// blocks), Write drops the line instead of blocking. This is critical: a
// blocking stdout write previously stalled the main scheduler goroutine for
// hours when the Railway log forwarder hiccuped.
type LogBuffer struct {
	mu    sync.Mutex
	lines []string
	head  int
	full  bool
	next  io.Writer

	stdoutCh    chan []byte
	dropped     uint64 // atomic — bytes dropped because stdoutCh was full
	lastWriteNs int64  // atomic — UnixNano of last Write; used by watchdog
}

func NewLogBuffer(next io.Writer, size int) *LogBuffer {
	b := &LogBuffer{
		lines:    make([]string, size),
		next:     next,
		stdoutCh: make(chan []byte, 1024),
	}
	if next != nil {
		go b.drainStdout()
	}
	return b
}

func (b *LogBuffer) Write(p []byte) (int, error) {
	atomic.StoreInt64(&b.lastWriteNs, time.Now().UnixNano())
	// Always update the in-memory ring (cheap, only mutex contention with /logs reader).
	b.mu.Lock()
	for _, line := range bytes.Split(bytes.TrimRight(p, "\n"), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		b.lines[b.head] = string(line)
		b.head = (b.head + 1) % len(b.lines)
		if b.head == 0 {
			b.full = true
		}
	}
	b.mu.Unlock()

	// Async stdout: copy because the caller can reuse p, then non-blocking send.
	if b.next != nil {
		cp := make([]byte, len(p))
		copy(cp, p)
		select {
		case b.stdoutCh <- cp:
		default:
			atomic.AddUint64(&b.dropped, uint64(len(p)))
		}
	}
	return len(p), nil
}

func (b *LogBuffer) drainStdout() {
	for p := range b.stdoutCh {
		_, _ = b.next.Write(p)
	}
}

// DroppedBytes returns how many stdout bytes were dropped because the async
// channel was full. Exposed for /status diagnostics.
func (b *LogBuffer) DroppedBytes() uint64 {
	return atomic.LoadUint64(&b.dropped)
}

// LastWriteAge returns how long since the last Write call. If no Write has
// happened yet (process startup), returns 0. Used by the watchdog goroutine
// to detect a fully frozen scheduler.
func (b *LogBuffer) LastWriteAge() time.Duration {
	ns := atomic.LoadInt64(&b.lastWriteNs)
	if ns == 0 {
		return 0
	}
	return time.Since(time.Unix(0, ns))
}

// Snapshot returns the last `n` lines (or all if n<=0). Newest line last.
func (b *LogBuffer) Snapshot(n int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()

	var out []string
	if !b.full {
		out = append(out, b.lines[:b.head]...)
	} else {
		out = make([]string, 0, len(b.lines))
		out = append(out, b.lines[b.head:]...)
		out = append(out, b.lines[:b.head]...)
	}
	if n > 0 && n < len(out) {
		out = out[len(out)-n:]
	}
	return out
}
