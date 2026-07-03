package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// store.go — SQLite persistence for priced + pending swaps.
//
// Schema:
//   swaps(
//     id           TEXT PRIMARY KEY,
//     created_at   INTEGER NOT NULL,   -- unix seconds
//     status       TEXT    NOT NULL,
//     volume_usd   REAL    NOT NULL,
//     gas_usd      REAL    NOT NULL,
//     appfees_usd  REAL    NOT NULL,
//     margin_usd   REAL    NOT NULL,
//     chain_in     INTEGER NOT NULL,
//     chain_out    INTEGER NOT NULL,
//     priced       INTEGER NOT NULL    -- 0/1, lets us re-price later
//   )
//
// We use modernc.org/sqlite (pure Go, CGO_DISABLED-safe so the
// Dockerfile keeps producing a static binary).

// Store wraps a SQLite handle. Safe for concurrent use (SQLite
// serialises writes internally; the harness only has one writer
// goroutine anyway).
type Store struct {
	db *sql.DB
}

// OpenStore opens (or creates) the SQLite file at `path` and ensures
// the schema is migrated. The migration is idempotent.
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS swaps (
			id           TEXT PRIMARY KEY,
			created_at   INTEGER NOT NULL,
			status       TEXT    NOT NULL,
			volume_usd   REAL    NOT NULL DEFAULT 0,
			gas_usd      REAL    NOT NULL DEFAULT 0,
			appfees_usd  REAL    NOT NULL DEFAULT 0,
			margin_usd   REAL    NOT NULL DEFAULT 0,
			chain_in     INTEGER NOT NULL DEFAULT 0,
			chain_out    INTEGER NOT NULL DEFAULT 0,
			priced       INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_swaps_created_at ON swaps(created_at);
		CREATE INDEX IF NOT EXISTS idx_swaps_status     ON swaps(status);
		CREATE INDEX IF NOT EXISTS idx_swaps_priced     ON swaps(priced);
	`); err != nil {
		return nil, fmt.Errorf("migrate schema: %w", err)
	}

	// One-shot scrub of historical rows that the older, looser margin
	// filter let through (June 2026 audit). Anything outside the new
	// [-$5k, $10k] band was a pricing artifact and was polluting the
	// 7d / 30d aggregates with persistent negative totals. Flip those
	// rows to priced=0 so the rollups exclude them from now on; the
	// rows stay in the table so the swap count and unpriced totals are
	// accurate. Idempotent (running it after the data is clean is a
	// no-op).
	if _, err := db.Exec(`
		UPDATE swaps
		SET priced = 0, margin_usd = 0
		WHERE priced = 1 AND (margin_usd > 1e4 OR margin_usd < -5e3);
	`); err != nil {
		return nil, fmt.Errorf("scrub implausible margins: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the underlying handle.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// Exists returns true if the swap is already persisted. Used by the
// polling loop to break out of pagination on the first known id (we
// only ever walk backwards from "now", so a hit means we've caught
// up).
func (s *Store) Exists(ctx context.Context, id string) (bool, error) {
	row := s.db.QueryRowContext(ctx, `SELECT 1 FROM swaps WHERE id = ? LIMIT 1`, id)
	var v int
	switch err := row.Scan(&v); {
	case err == nil:
		return true, nil
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	default:
		return false, err
	}
}

// Upsert persists or replaces a swap. We upsert (not insert) so that
// re-priced swaps (status=success arriving later than the first poll)
// overwrite the earlier pending row.
func (s *Store) Upsert(ctx context.Context, sw Swap) error {
	priced := 0
	if sw.Priced {
		priced = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO swaps (id, created_at, status, volume_usd, gas_usd, appfees_usd, margin_usd, chain_in, chain_out, priced)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			status      = excluded.status,
			volume_usd  = excluded.volume_usd,
			gas_usd     = excluded.gas_usd,
			appfees_usd = excluded.appfees_usd,
			margin_usd  = excluded.margin_usd,
			chain_in    = excluded.chain_in,
			chain_out   = excluded.chain_out,
			priced      = excluded.priced
	`,
		sw.ID, sw.CreatedAt, sw.Status,
		sw.VolumeUSD, sw.GasUSD, sw.AppFeesUSD, sw.MarginUSD,
		sw.ChainIn, sw.ChainOut, priced,
	)
	if err != nil {
		return fmt.Errorf("upsert swap %s: %w", sw.ID, err)
	}
	return nil
}

// MaxCreatedAt returns the unix-sec timestamp of the most recent swap
// in the DB, or 0 if the DB is empty. Used at startup to resume from
// (max-3min) so we re-fetch the lag window per spec.
func (s *Store) MaxCreatedAt(ctx context.Context) (int64, error) {
	row := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(created_at), 0) FROM swaps`)
	var v int64
	if err := row.Scan(&v); err != nil {
		return 0, err
	}
	return v, nil
}

// WindowAggregates is the aggregate the metrics layer needs per window.
type WindowAggregates struct {
	VolumeUSD float64
	MarginUSD float64
	GasUSD    float64
	FeesUSD   float64
	Count     int64
}

// AggregateSince returns volume/margin/count over swaps with
// status='success' and priced=1 created in the [since, now] range.
// Unpriced swaps are intentionally excluded — they would skew the
// take_rate downward by adding volume without margin.
func (s *Store) AggregateSince(ctx context.Context, since int64) (WindowAggregates, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(volume_usd),  0),
			COALESCE(SUM(margin_usd),  0),
			COALESCE(SUM(gas_usd),     0),
			COALESCE(SUM(appfees_usd), 0),
			COUNT(*)
		FROM swaps
		WHERE status = 'success' AND priced = 1 AND created_at >= ?
	`, since)
	var agg WindowAggregates
	if err := row.Scan(&agg.VolumeUSD, &agg.MarginUSD, &agg.GasUSD, &agg.FeesUSD, &agg.Count); err != nil {
		return WindowAggregates{}, err
	}
	return agg, nil
}

// PricedCounts returns (priced_total, unpriced_total) over the whole DB.
// Used to surface "do we trust the take_rate?" via Prom counters.
func (s *Store) PricedCounts(ctx context.Context) (int64, int64, error) {
	var priced, unpriced int64
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM swaps WHERE status='success' AND priced=1`)
	if err := row.Scan(&priced); err != nil {
		return 0, 0, err
	}
	row = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM swaps WHERE status='success' AND priced=0`)
	if err := row.Scan(&unpriced); err != nil {
		return 0, 0, err
	}
	return priced, unpriced, nil
}

// resumeSince computes the timestamp the polling loop should start
// from on boot: max(created_at) - 3 min (to re-fetch the lag window)
// or 0 when the DB is empty (fresh start = lazy backfill).
func (s *Store) resumeSince(ctx context.Context) (int64, error) {
	maxAt, err := s.MaxCreatedAt(ctx)
	if err != nil {
		return 0, err
	}
	if maxAt == 0 {
		return 0, nil
	}
	return maxAt - int64(3*time.Minute/time.Second), nil
}
