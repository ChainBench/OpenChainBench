package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// State layer = pure-Go SQLite under $STATE_DIR/state.db (defaults to
// ./state.db). One table records (builder, user) first-seen / last-seen
// timestamps so we can compute cohort retention without re-parsing the
// full CSV history every cycle.
//
// This is the differentiator vs every other Hyperliquid frontends
// dashboard — nobody publishes D7/D30 retention per builder cleanly
// because nobody bothers maintaining the state. Five lines of SQL
// plus a single 100 MB file on a Railway volume gets us a metric the
// rest of the field can't match.

type State struct {
	db *sql.DB
}

func OpenState() (*State, error) {
	dir := os.Getenv("STATE_DIR")
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir state: %w", err)
	}
	path := filepath.Join(dir, "state.db")
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS user_activity (
			builder        TEXT NOT NULL,
			user           TEXT NOT NULL,
			first_seen_ms  INTEGER NOT NULL,
			last_seen_ms   INTEGER NOT NULL,
			fills          INTEGER NOT NULL DEFAULT 0,
			notional_usd   REAL NOT NULL DEFAULT 0,
			PRIMARY KEY (builder, user)
		);
		CREATE INDEX IF NOT EXISTS idx_user_activity_first_seen
			ON user_activity(builder, first_seen_ms);
		CREATE INDEX IF NOT EXISTS idx_user_activity_last_seen
			ON user_activity(builder, last_seen_ms);
	`); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	fmt.Printf("[state] sqlite opened at %s\n", path)
	return &State{db: db}, nil
}

// Upsert one observation. Idempotent: re-running the same CSV is safe
// because first_seen is `MIN(existing, candidate)` and last_seen is
// `MAX(existing, candidate)`. Fills + notional aggregate via SUM but
// we de-dupe on the caller side per cycle (only NEW rows passed in).
func (s *State) Upsert(builder, user string, tsMs int64, notionalUSD float64) error {
	_, err := s.db.Exec(`
		INSERT INTO user_activity (builder, user, first_seen_ms, last_seen_ms, fills, notional_usd)
		VALUES (?, ?, ?, ?, 1, ?)
		ON CONFLICT(builder, user) DO UPDATE SET
			first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms),
			last_seen_ms  = MAX(last_seen_ms,  excluded.last_seen_ms),
			fills         = fills + 1,
			notional_usd  = notional_usd + excluded.notional_usd
	`, builder, user, tsMs, tsMs, notionalUSD)
	return err
}

// Retention computes cohort retention for the given builder + window
// in days. Definition: of users whose first_seen_ms falls in the
// 24-hour window starting `days` ago, what fraction had a last_seen_ms
// within the last 24 hours.
//
//   cohort  = COUNT first_seen ∈ [now - days*24h, now - (days-1)*24h)
//   active  = COUNT first_seen ∈ that bucket AND last_seen ≥ (now - 24h)
//   ratio   = active / cohort  (0 when cohort empty)
//
// D7 → days=7. D30 → days=30.
func (s *State) Retention(ctx context.Context, builder string, days int) (float64, int, error) {
	now := time.Now().UTC().UnixMilli()
	cohortStart := now - int64(days)*86_400_000
	cohortEnd := now - int64(days-1)*86_400_000
	activeAfter := now - 86_400_000

	var cohort, returned int
	// COALESCE because SUM(CASE) returns NULL on an empty result
	// set (no users in the cohort window). database/sql can't scan
	// NULL into a plain int, so we coerce to 0 in SQL.
	err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*) AS cohort,
			COALESCE(SUM(CASE WHEN last_seen_ms >= ? THEN 1 ELSE 0 END), 0) AS returned
		FROM user_activity
		WHERE builder = ?
		  AND first_seen_ms >= ?
		  AND first_seen_ms < ?
	`, activeAfter, builder, cohortStart, cohortEnd).Scan(&cohort, &returned)
	if err != nil {
		return 0, 0, err
	}
	if cohort == 0 {
		return 0, 0, nil
	}
	return float64(returned) / float64(cohort) * 100, cohort, nil
}

// PruneOlderThan removes activity rows older than the retention horizon
// so the SQLite file doesn't grow forever. Run once per cycle.
func (s *State) PruneOlderThan(days int) (int64, error) {
	cutoff := time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).UnixMilli()
	res, err := s.db.Exec(`DELETE FROM user_activity WHERE last_seen_ms < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (s *State) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}
