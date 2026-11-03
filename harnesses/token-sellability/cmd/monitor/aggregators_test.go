package main

import (
	"strings"
	"testing"
)

// The reason an aggregator refused is in the body, and the log line is where
// it has to end up. A bare status cannot tell an unsupported chain from a
// token the aggregator cannot describe, and those call for opposite fixes.
func TestBadStatusCarriesTheReason(t *testing.T) {
	err := badStatus(400, []byte(`{"error":"destDecimals is required"}`))
	if !strings.Contains(err.Error(), "destDecimals") {
		t.Errorf("the body must reach the message, got %q", err)
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("the status must survive too, got %q", err)
	}
}

// A body spread over many lines would break the one-line log format, and a
// long one would bury the sweep summary.
func TestBadStatusStaysOnOneShortLine(t *testing.T) {
	err := badStatus(500, []byte("first line\n\n   second line\t"))
	if strings.ContainsAny(err.Error(), "\n\t") {
		t.Errorf("must collapse to one line, got %q", err)
	}
	if err.Error() != "http 500: first line second line" {
		t.Errorf("unexpected rendering %q", err)
	}

	long := badStatus(502, []byte(strings.Repeat("x", 500)))
	if len(long.Error()) > 200 {
		t.Errorf("must be trimmed, got %d chars", len(long.Error()))
	}
}

// An empty body still has to say something, or the log reads as a missing
// value rather than a silent upstream.
func TestBadStatusSaysWhenTheBodyIsEmpty(t *testing.T) {
	if got := badStatus(429, []byte("   ")).Error(); got != "http 429, empty body" {
		t.Errorf("got %q", got)
	}
}

// The slug and the id are hardcoded in the same file, so the one helper that
// relates them is worth pinning.
func TestChainSlugTracksTheID(t *testing.T) {
	if got := chainSlugFor(chainID); got != chainSlug {
		t.Errorf("the bench chain must map to its slug, got %q", got)
	}
	if got := chainSlugFor(1); got != "1" {
		t.Errorf("an unknown id falls back to its number, got %q", got)
	}
}
