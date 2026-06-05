package main

import (
	"errors"
	"net"
	"strings"
)

// classifyNetErr buckets transport errors into a small fixed set for the
// `error_type` label on the other-errors counter.
func classifyNetErr(err error) string {
	if err == nil {
		return "none"
	}
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "context deadline exceeded") || strings.Contains(s, "timeout"):
		return "timeout"
	case strings.Contains(s, "eof") || strings.Contains(s, "reset"):
		return "conn_drop"
	case strings.Contains(s, "no such host") || strings.Contains(s, "lookup"):
		return "dns"
	}
	var ne net.Error
	if errors.As(err, &ne) {
		if ne.Timeout() {
			return "timeout"
		}
	}
	return "network"
}

// snippet returns at most n bytes of a response body for logging without
// leaking long error pages into the ring buffer.
func snippet(b []byte) string {
	if len(b) > 200 {
		return string(b[:200])
	}
	return string(b)
}
