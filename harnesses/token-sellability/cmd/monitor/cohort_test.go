package main

import (
	"testing"
	"time"
)

// The three shapes this rule exists to tell apart, named as they were counted
// over 24h on 2026-11-05: 61 never sold, 39 came back, 5 stayed down.

// A token we have never sold is scored on sight. There is no sale of ours to
// contradict it, and waiting would only delay a true finding.
func TestNeverSoldIsScoredOnSight(t *testing.T) {
	m := newCohortMemory(time.Hour)
	m.Observe("0xa", false)
	if !m.Scoreable("0xa") {
		t.Error("a token we have never sold is scoreable at once")
	}
	if m.Provisional("0xa") {
		t.Error("it is not provisional, nothing contradicts it")
	}
}

// The 39: sold, then a failure, then sold again. The failure was the
// instrument and must never reach the board.
func TestAFailureThatReversesIsNeverScored(t *testing.T) {
	m := newCohortMemory(time.Hour)
	m.Observe("0xa", true)
	m.Observe("0xa", false)
	if m.Scoreable("0xa") {
		t.Fatal("one failure after a sale is not enough to name a company")
	}
	if !m.Provisional("0xa") {
		t.Error("it should read as held pending confirmation")
	}
	m.Observe("0xa", true) // it came back
	if m.Scoreable("0xa") {
		t.Error("a token that sold again must not be scoreable")
	}
	if m.Provisional("0xa") {
		t.Error("and it is no longer pending anything")
	}
}

// The 5: sold, then failed, and stayed failed. This is a rug and it is the
// event the bench exists to catch, so the rule must let it through.
func TestAFailureThatPersistsBecomesARug(t *testing.T) {
	m := newCohortMemory(time.Hour)
	m.Observe("0xa", true)
	m.Observe("0xa", false)
	if m.Scoreable("0xa") {
		t.Fatal("not yet, one observation")
	}
	m.Observe("0xa", false)
	if !m.Scoreable("0xa") {
		t.Error("a second consecutive failure confirms it")
	}
	if m.Provisional("0xa") {
		t.Error("confirmed is not provisional")
	}
}

// A sale in the middle resets the count, or a token that fails on alternate
// sweeps would eventually accumulate two and be published.
func TestASaleInTheMiddleResetsTheCount(t *testing.T) {
	m := newCohortMemory(time.Hour)
	m.Observe("0xa", true)
	m.Observe("0xa", false)
	m.Observe("0xa", true)
	m.Observe("0xa", false)
	if m.Scoreable("0xa") {
		t.Error("alternating failures must never accumulate into a verdict")
	}
}

// A token we have not observed at all is not scoreable, so a failure read
// before any history exists is treated as the first observation.
func TestAnUnobservedTokenIsNotScoreable(t *testing.T) {
	m := newCohortMemory(time.Hour)
	if m.Scoreable("0xunknown") {
		t.Error("no history means nothing confirmed")
	}
}

func TestTheMemoryLetsGoOutsideTheWindow(t *testing.T) {
	m := newCohortMemory(40 * time.Millisecond)
	m.Observe("0xa", false)
	if n := m.Prune(); n != 1 {
		t.Fatalf("still inside the window, got %d", n)
	}
	time.Sleep(60 * time.Millisecond)
	if n := m.Prune(); n != 0 {
		t.Errorf("outside the window it must be dropped, %d left", n)
	}
}
