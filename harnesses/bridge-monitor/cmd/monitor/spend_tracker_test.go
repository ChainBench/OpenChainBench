package main

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSpendTrackerUTCRollover(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spend-state.json")
	now := time.Date(2026, 7, 12, 23, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }

	tr := NewSpendTracker(path, clock)
	tr.Add(3.5)
	if got := tr.Spent(); math.Abs(got-3.5) > 1e-9 {
		t.Fatalf("expected 3.5 spent, got %v", got)
	}

	// A restart within the same UTC day must keep the consumed budget: a
	// crash-loop must not mint a fresh budget.
	tr2 := NewSpendTracker(path, clock)
	if got := tr2.Spent(); math.Abs(got-3.5) > 1e-9 {
		t.Fatalf("restart lost same-day spend: got %v, want 3.5", got)
	}

	// Crossing midnight UTC resets the counter without a restart.
	now = time.Date(2026, 7, 13, 1, 0, 0, 0, time.UTC)
	if got := tr2.Spent(); got != 0 {
		t.Fatalf("expected 0 after UTC date rollover, got %v", got)
	}
	tr2.Add(1.25)

	// A restart on the new day loads the new day's spend.
	tr3 := NewSpendTracker(path, clock)
	if got := tr3.Spent(); math.Abs(got-1.25) > 1e-9 {
		t.Fatalf("restart on new day: got %v, want 1.25", got)
	}
}

func TestSpendTrackerDiscardsStaleState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spend-state.json")
	if err := os.WriteFile(path, []byte(`{"date":"2026-07-11","spent_usd":9.99}`), 0o644); err != nil {
		t.Fatal(err)
	}
	clock := func() time.Time { return time.Date(2026, 7, 12, 8, 0, 0, 0, time.UTC) }
	tr := NewSpendTracker(path, clock)
	if got := tr.Spent(); got != 0 {
		t.Fatalf("yesterday's spend must not carry over, got %v", got)
	}
}

func TestSpendTrackerIgnoresCorruptState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spend-state.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	tr := NewSpendTracker(path, nil)
	if got := tr.Spent(); got != 0 {
		t.Fatalf("corrupt state must read as 0, got %v", got)
	}
	tr.Add(2)
	if got := tr.Spent(); math.Abs(got-2) > 1e-9 {
		t.Fatalf("expected 2 after Add, got %v", got)
	}
}

func TestFailedTxFeeEstimateDefault(t *testing.T) {
	t.Setenv("FAILED_TX_FEE_ESTIMATE_USD", "")
	if got := failedTxFeeEstimateUSD(); math.Abs(got-0.50) > 1e-9 {
		t.Fatalf("default estimate must be $0.50, got %v", got)
	}
	t.Setenv("FAILED_TX_FEE_ESTIMATE_USD", "1.25")
	if got := failedTxFeeEstimateUSD(); math.Abs(got-1.25) > 1e-9 {
		t.Fatalf("env override not honored, got %v", got)
	}
}
