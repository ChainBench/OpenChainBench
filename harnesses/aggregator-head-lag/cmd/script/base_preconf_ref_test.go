package main

import (
	"os"
	"testing"
	"time"
)

// Base now has two reference sources and the whole safety argument for adding
// the second one rests on a single property: the clock keeps the EARLIEST
// observation, so a new source can only move the zero point earlier and a slow
// source is simply never used.
//
// If that property ever breaks, every published Base head-lag number moves and
// nothing else in the harness would notice, so it gets a test.

func TestObserveFirstKeepsTheEarliest(t *testing.T) {
	r := &refClock{seen: map[string]refEntry{}}
	early := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	late := early.Add(180 * time.Millisecond)

	if !r.observeFirst("base", "0xAA", late) {
		t.Fatal("the first observation of a hash must report that it set the entry")
	}
	if r.observeFirst("base", "0xAA", early) {
		t.Fatal("a second observation must report that it did NOT set the entry")
	}
	got, ok := r.lookup("base", "0xAA")
	if !ok {
		t.Fatal("hash went missing")
	}
	// The LATE one arrived first and therefore wins. That is the documented
	// behaviour: the clock is first-writer, not minimum-over-time, because a
	// later duplicate is a redelivery rather than a new sighting.
	if !got.Equal(late) {
		t.Fatalf("expected the first writer to hold the entry, got %v want %v", got, late)
	}
}

func TestPreconfArrivingFirstMovesTheZeroPointEarlier(t *testing.T) {
	r := &refClock{seen: map[string]refEntry{}}
	preconf := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	flashblocks := preconf.Add(181 * time.Millisecond) // the measured p90 tail

	// Preconf wins the race for this transaction.
	if !r.observeFirst("base", "0xBB", preconf) {
		t.Fatal("preconf should have set the entry")
	}
	if r.observeFirst("base", "0xBB", flashblocks) {
		t.Fatal("flashblocks arrived later and must not overwrite")
	}
	got, _ := r.lookup("base", "0xBB")
	if !got.Equal(preconf) {
		t.Fatalf("zero point should be the preconf sighting, got %v", got)
	}
}

func TestSlowPreconfChangesNothing(t *testing.T) {
	// The 59 % of transactions where preconf is later must leave the
	// reference exactly as it was before this source existed, or adding it
	// would be a regression rather than a tail fix.
	r := &refClock{seen: map[string]refEntry{}}
	flashblocks := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	preconf := flashblocks.Add(8 * time.Millisecond) // the measured median

	r.observeFirst("base", "0xCC", flashblocks)
	r.observeFirst("base", "0xCC", preconf)
	got, _ := r.lookup("base", "0xCC")
	if !got.Equal(flashblocks) {
		t.Fatalf("a slower second source must not move the zero point, got %v", got)
	}
}

func TestObserveStillWorksForTheOtherChains(t *testing.T) {
	// observe() is now a thin wrapper. Solana, BNB and Robinhood still call
	// it and must behave exactly as before.
	r := &refClock{seen: map[string]refEntry{}}
	first := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	r.observe("solana", "SIG", first)
	r.observe("solana", "SIG", first.Add(-50*time.Millisecond))
	got, ok := r.lookup("solana", "SIG")
	if !ok || !got.Equal(first) {
		t.Fatalf("observe must keep the first write, got %v ok=%v", got, ok)
	}
	if _, ok := r.lookup("base", "SIG"); ok {
		t.Fatal("chains must not share a key space")
	}
}

func TestBasePreconfURLIsOverridableAndDisablable(t *testing.T) {
	// An empty override disables the source, which is the rollback switch:
	// set BASE_PRECONF_WS_URL="" on the service and Base goes back to the
	// flashblocks-only reference without a redeploy of the binary.
	t.Setenv("BASE_PRECONF_WS_URL", "")
	if got := basePreconfURL(); got != "" {
		t.Fatalf("empty override must disable the source, got %q", got)
	}
	t.Setenv("BASE_PRECONF_WS_URL", "wss://example.invalid/ws")
	if got := basePreconfURL(); got != "wss://example.invalid/ws" {
		t.Fatalf("override not honoured, got %q", got)
	}
	os.Unsetenv("BASE_PRECONF_WS_URL")
	if got := basePreconfURL(); got != basePreconfDefaultURL {
		t.Fatalf("unset must fall back to the default, got %q", got)
	}
}
