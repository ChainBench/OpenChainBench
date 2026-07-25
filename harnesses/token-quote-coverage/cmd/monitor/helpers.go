package main

import (
	"errors"
	"net"
	"strings"
)

// classifyNetErr buckets transport errors into a small fixed set for logging.
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

// chainSlug maps Virtuals API chain names (e.g. "ROBINHOOD", "BASE") to our chain slugs.
func chainSlug(apiChain string) string {
	switch strings.ToUpper(apiChain) {
	case "ROBINHOOD":
		return "robinhood"
	case "BASE":
		return "base"
	case "BSC", "BNB":
		return "bsc"
	case "SOLANA":
		return "solana"
	default:
		return "base" // fallback: Virtuals was originally Base-only
	}
}

// snippet returns at most 200 bytes of a response body for logging.
func snippet(b []byte) string {
	if len(b) > 200 {
		return string(b[:200])
	}
	return string(b)
}
