package main

import (
	"testing"
	"time"
)

// The duty cycle's arithmetic is the one part of it that can fail silently.
//
// If two providers compute different window boundaries they listen to
// different blocks, and the race still produces numbers: each one is its own
// leader, every lead reads zero, and the board says every provider is
// fastest. That is worse than an outage, so the boundary is derived from the
// wall clock and pinned here.
func TestWindowIsAlignedToTheClock(t *testing.T) {
	t.Setenv("RPC_KEYED_WS_DUTY_SECONDS", "600")
	t.Setenv("RPC_KEYED_WS_PERIOD_SECONDS", "3600")

	cases := []struct {
		at        string
		wait      time.Duration
		remaining time.Duration
	}{
		// Inside the window: listen now, until it closes.
		{"2026-10-17T09:00:00Z", 0, 10 * time.Minute},
		{"2026-10-17T09:03:00Z", 0, 7 * time.Minute},
		{"2026-10-17T09:09:59Z", 0, time.Second},
		// Outside it: wait for the top of the next hour.
		{"2026-10-17T09:10:00Z", 50 * time.Minute, 10 * time.Minute},
		{"2026-10-17T09:30:00Z", 30 * time.Minute, 10 * time.Minute},
		{"2026-10-17T09:59:30Z", 30 * time.Second, 10 * time.Minute},
	}
	for _, c := range cases {
		now, err := time.Parse(time.RFC3339, c.at)
		if err != nil {
			t.Fatal(err)
		}
		wait, remaining := wsWindowAt(now)
		if wait != c.wait || remaining != c.remaining {
			t.Errorf("at %s: got wait=%s remaining=%s, want wait=%s remaining=%s",
				c.at, wait, remaining, c.wait, c.remaining)
		}
	}
}

// Two cells in different goroutines, asked at slightly different instants,
// must agree on when the window opens. This is the property the race needs.
func TestEveryCellAgreesOnTheSameWindow(t *testing.T) {
	t.Setenv("RPC_KEYED_WS_DUTY_SECONDS", "600")
	t.Setenv("RPC_KEYED_WS_PERIOD_SECONDS", "3600")

	base, _ := time.Parse(time.RFC3339, "2026-10-17T09:42:00Z")
	first, _ := wsWindowAt(base)
	openAt := base.Add(first)
	for _, skew := range []time.Duration{0, 7 * time.Millisecond, 400 * time.Millisecond, 3 * time.Second} {
		at := base.Add(skew)
		wait, _ := wsWindowAt(at)
		if got := at.Add(wait); !got.Equal(openAt) {
			t.Errorf("skew %s opens at %s, want %s", skew, got, openAt)
		}
	}
}

// A window as long as its period is the old continuous behaviour, which is
// how the arm is restored without touching code.
func TestAWindowAsLongAsThePeriodNeverCloses(t *testing.T) {
	t.Setenv("RPC_KEYED_WS_DUTY_SECONDS", "3600")
	t.Setenv("RPC_KEYED_WS_PERIOD_SECONDS", "3600")
	now := time.Now()
	wait, remaining := wsWindowAt(now)
	if wait != 0 {
		t.Errorf("wait = %s, want 0", wait)
	}
	if remaining != time.Hour {
		t.Errorf("remaining = %s, want 1h", remaining)
	}
}

// The skip list is compiled in so a lost variable cannot restore the bill,
// and "none" is the deliberate way to empty it.
func TestSkipListDefaultsToTheThreeFastestChains(t *testing.T) {
	t.Setenv("RPC_KEYED_WS_SKIP_CHAINS", "")
	skip := wsSkipChains()
	for _, c := range []string{"robinhood", "solana", "arbitrum"} {
		if !skip[c] {
			t.Errorf("%s should be skipped by default", c)
		}
	}
	if skip["ethereum"] {
		t.Error("ethereum must not be skipped by default")
	}

	t.Setenv("RPC_KEYED_WS_SKIP_CHAINS", "none")
	if len(wsSkipChains()) != 0 {
		t.Error(`"none" should empty the skip list`)
	}

	t.Setenv("RPC_KEYED_WS_SKIP_CHAINS", " Base , POLYGON ")
	skip = wsSkipChains()
	if !skip["base"] || !skip["polygon"] || skip["robinhood"] {
		t.Errorf("an explicit list should replace the default, got %v", skip)
	}
}
