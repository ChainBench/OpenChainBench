package main

import (
	"testing"
	"time"
)

// The rule this file exists for: a token this probe has sold is never scored
// against anyone afterwards, however many later sweeps say it reverted. 31 of
// 94 tokens in the cohort carried both verdicts on 2026-11-05, which is a
// third of the evidence the board names companies against.
func TestASoldTokenIsNeverScoredAgain(t *testing.T) {
	m := newSellableMemory(24 * time.Hour)
	if m.Contradicted("0xa") {
		t.Error("a token never seen must not be excluded")
	}
	m.Record("0xa")
	if !m.Contradicted("0xa") {
		t.Error("a token we sold must be excluded from the cohort")
	}
	if m.Contradicted("0xb") {
		t.Error("recording one token must not exclude another")
	}
}

// Outside the window the memory must let go, or the cohort would shrink for
// the life of the process and the board would quietly measure less and less.
func TestTheMemoryLetsGoOutsideTheWindow(t *testing.T) {
	m := newSellableMemory(50 * time.Millisecond)
	m.Record("0xa")
	if !m.Contradicted("0xa") {
		t.Fatal("inside the window it holds")
	}
	time.Sleep(70 * time.Millisecond)
	if m.Contradicted("0xa") {
		t.Error("outside the window the token is scoreable again")
	}
	if n := m.Prune(); n != 0 {
		t.Errorf("prune must drop it, %d left", n)
	}
}

// Prune reports what it still holds, because that number is logged every
// sweep and a rule nobody can see the size of is a rule nobody checks.
func TestPruneReportsWhatItStillHolds(t *testing.T) {
	m := newSellableMemory(time.Hour)
	for _, tok := range []string{"0xa", "0xb", "0xc"} {
		m.Record(tok)
	}
	if n := m.Prune(); n != 3 {
		t.Errorf("expected 3 held, got %d", n)
	}
}
