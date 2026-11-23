package main

import (
	"testing"
	"time"
)

// Everything needs two consecutive failures now, a token we have never sold
// included. The first version scored a first sighting on one observation,
// which is the same single-sample claim the rule exists to refuse.
func TestEvenAFirstSightingNeedsConfirming(t *testing.T) {
	m := newCohortMemory(time.Hour, "")
	m.Observe("0xa", "delayed", false)
	if m.Scoreable("0xa", "delayed") {
		t.Error("one observation is one sample and must not name a company")
	}
	if !m.Provisional("0xa", "delayed") {
		t.Error("it should read as held pending confirmation")
	}
	m.Observe("0xa", "delayed", false)
	if !m.Scoreable("0xa", "delayed") {
		t.Error("a second consecutive failure confirms it")
	}
}

// The 39: a failure that reverses was the instrument and must never reach the
// board, however often it recurs afterwards.
func TestAFailureThatReversesIsNeverScored(t *testing.T) {
	m := newCohortMemory(time.Hour, "")
	m.Observe("0xa", "delayed", false)
	m.Observe("0xa", "delayed", true) // it sold
	if m.Scoreable("0xa", "delayed") || m.Provisional("0xa", "delayed") {
		t.Error("a sale clears the count entirely")
	}
	m.Observe("0xa", "delayed", false)
	if m.Scoreable("0xa", "delayed") {
		t.Error("the count restarts from the sale, it does not resume")
	}
}

// The tiers are counted apart. The old shape marked a token sold if it sold
// at EITHER timing, which erased exactly the anti-bot cooldown the two
// timings exist to separate: blocked in the same block, fine a few blocks
// later. The two tabs then agreed on 1000 of 1000 ledger rows.
func TestACooldownSurvivesInTheSameBlockTier(t *testing.T) {
	m := newCohortMemory(time.Hour, "")
	for i := 0; i < 2; i++ {
		m.Observe("0xa", "same_block", false) // blocked in the same block
		m.Observe("0xa", "delayed", true)     // fine a few blocks later
	}
	if !m.Scoreable("0xa", "same_block") {
		t.Error("the same-block failure must survive a delayed sale")
	}
	if m.Scoreable("0xa", "delayed") {
		t.Error("the delayed tier sold, so it has nothing to score")
	}
}

// The memory has to outlive the process. It did not: the harness restarted
// ten times on the day it shipped and the rule never fired once, because
// every token read as a first sighting after every restart.
func TestTheMemorySurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	m := newCohortMemory(time.Hour, dir)
	m.Observe("0xa", "delayed", false)
	m.Observe("0xa", "delayed", false)
	if n := m.Prune(); n != 1 {
		t.Fatalf("expected one tracked token, got %d", n)
	}

	restarted := newCohortMemory(time.Hour, dir)
	if !restarted.Scoreable("0xa", "delayed") {
		t.Error("two confirmed failures must survive a restart")
	}
}

// What left the window does not come back on reload, or the cohort would grow
// for the life of the file rather than describing the last day.
func TestStaleStateIsNotRestored(t *testing.T) {
	dir := t.TempDir()
	m := newCohortMemory(50*time.Millisecond, dir)
	m.Observe("0xa", "delayed", false)
	m.Prune()
	time.Sleep(70 * time.Millisecond)

	restarted := newCohortMemory(50*time.Millisecond, dir)
	if restarted.Scoreable("0xa", "delayed") {
		t.Error("a token outside the window must not be restored")
	}
}

// With nowhere to write it still works, in memory, rather than refusing to
// run or silently scoring everything.
func TestItWorksWithoutAPlaceToWrite(t *testing.T) {
	m := newCohortMemory(time.Hour, "")
	m.Observe("0xa", "delayed", false)
	m.Observe("0xa", "delayed", false)
	if !m.Scoreable("0xa", "delayed") {
		t.Error("no persistence must not mean no rule")
	}
}
