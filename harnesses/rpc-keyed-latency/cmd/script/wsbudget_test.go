package main

import (
	"testing"
	"time"
)

// The guard exists so a WebSocket overrun cannot spend the key the HTTP
// boards share. Pinned: it trips at the budget, not before, it never trips
// for a provider without one, and the calendar month reopens it.
func TestWSByteBudgetTripsAtTheBudgetAndResetsWithTheMonth(t *testing.T) {
	t.Setenv("RPC_KEYED_WS_BYTE_BUDGET_ALCHEMY", "1000")
	g := &wsByteGuard{used: make(map[string]int64)}
	nov := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)

	if g.add("alchemy", 999, nov) {
		t.Fatal("tripped at 999 of 1000 bytes")
	}
	if g.exhausted("alchemy", nov) {
		t.Fatal("exhausted at 999 of 1000 bytes")
	}
	if !g.add("alchemy", 1, nov) {
		t.Fatal("did not trip at 1000 of 1000 bytes")
	}
	if !g.exhausted("alchemy", nov) {
		t.Fatal("not exhausted after the budget was spent")
	}

	dec := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	if g.exhausted("alchemy", dec) {
		t.Fatal("still exhausted after the month turned")
	}
}

func TestWSByteBudgetNeverPausesAProviderWithoutOne(t *testing.T) {
	g := &wsByteGuard{used: make(map[string]int64)}
	now := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)
	if g.add("quicknode", 1<<40, now) || g.exhausted("quicknode", now) {
		t.Fatal("a provider with no budget was paused")
	}
	t.Setenv("RPC_KEYED_WS_BYTE_BUDGET_ALCHEMY", "none")
	if g.add("alchemy", 1<<40, now) {
		t.Fatal(`"none" did not remove the budget`)
	}
}

func TestAlchemyHasACompiledInByteBudget(t *testing.T) {
	// A lost environment variable must not remove the guard in silence.
	if wsByteBudget("alchemy") <= 0 {
		t.Fatal("alchemy has no default WebSocket byte budget")
	}
}
