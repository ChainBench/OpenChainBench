package main

import (
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// execMu is the package-level single-flight lock for every code path that can
// broadcast a transaction: scheduled triangle runs, the auto-rebalancer, the
// stuck-fund reaper and gas top-ups. All of these actors sign with the same
// two wallets, so two concurrent broadcasts race on PendingNonceAt and can
// reuse a nonce. Scheduler slots take the lock for the whole slot; the reaper
// only TryLocks and skips its corrective action when the lock is busy, it
// never queues behind a running slot.
var execMu sync.Mutex

// SpendTracker accounts spending against the daily cap. The counter is keyed
// by UTC date so the budget resets exactly at midnight UTC, and the
// (date, spent) pair is persisted to disk so a process restart within the
// same UTC day keeps the consumed budget instead of minting a fresh one
// (a crash-looping process used to reset the counter on every start).
type SpendTracker struct {
	mu    sync.Mutex
	path  string
	now   func() time.Time
	date  string
	spent float64
}

type spendState struct {
	Date     string  `json:"date"`
	SpentUSD float64 `json:"spent_usd"`
}

// NewSpendTracker loads persisted state from path. A nil clock uses time.Now;
// tests inject a fake clock to drive the date rollover. State recorded on a
// different UTC date is discarded on load.
func NewSpendTracker(path string, now func() time.Time) *SpendTracker {
	if now == nil {
		now = time.Now
	}
	t := &SpendTracker{path: path, now: now}
	t.date = t.utcDate()
	if data, err := os.ReadFile(path); err == nil {
		var s spendState
		if json.Unmarshal(data, &s) == nil && s.Date == t.date && s.SpentUSD > 0 {
			t.spent = s.SpentUSD
			log.Printf("💾 Loaded daily spend state: $%.2f already spent on %s (%s)", t.spent, t.date, path)
		}
	}
	return t
}

func (t *SpendTracker) utcDate() string {
	return t.now().UTC().Format("2006-01-02")
}

// rolloverLocked resets the counter when the UTC date has changed since the
// last access. Callers must hold t.mu.
func (t *SpendTracker) rolloverLocked() {
	if d := t.utcDate(); d != t.date {
		log.Printf("💾 Daily spend reset: %s -> %s (was $%.2f)", t.date, d, t.spent)
		t.date = d
		t.spent = 0
		t.saveLocked()
	}
}

// Add books usd against today's budget and persists the new total.
func (t *SpendTracker) Add(usd float64) {
	if usd <= 0 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.rolloverLocked()
	t.spent += usd
	t.saveLocked()
}

// Spent returns today's consumed budget, applying the UTC rollover first.
func (t *SpendTracker) Spent() float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.rolloverLocked()
	return t.spent
}

// saveLocked persists atomically (write temp, rename). Callers hold t.mu.
func (t *SpendTracker) saveLocked() {
	data, err := json.Marshal(spendState{Date: t.date, SpentUSD: t.spent})
	if err != nil {
		return
	}
	tmp := t.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("⚠️  Failed to persist spend state to %s: %v", tmp, err)
		return
	}
	if err := os.Rename(tmp, t.path); err != nil {
		log.Printf("⚠️  Failed to persist spend state to %s: %v", t.path, err)
	}
}

// spendStatePath resolves where the (date, spent) pair lives. Defaults to a
// path relative to the working directory (NOT /tmp, which some distros wipe
// on a timer) so restarts on the same host see the same file.
func spendStatePath() string {
	if p := strings.TrimSpace(os.Getenv("SPEND_STATE_PATH")); p != "" {
		return p
	}
	// Dry-run gets its own default file so simulated spend never eats the
	// production budget when both run on the same host (review pass 2).
	if strings.EqualFold(strings.TrimSpace(os.Getenv("EXECUTION_MODE")), "production") {
		return "./spend-state.json"
	}
	return "./spend-state.dryrun.json"
}

// failedTxFeeEstimateUSD is booked against the daily cap for any broadcast
// that produced a TxHash but never confirmed as a success: the deposit or
// approval TX most likely paid gas even though the bridge never filled.
func failedTxFeeEstimateUSD() float64 {
	return parseFloat(os.Getenv("FAILED_TX_FEE_ESTIMATE_USD"), 0.50)
}
