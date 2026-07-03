// store.go — DuckDB schema, upserts, checkpoints, query API.
//
// All persistence lives here so the rest of the package can stay
// driver-agnostic (we may swap DuckDB for SQLite if CGO becomes a
// build pain on Railway). Two tables only — see CREATE statements.
//
// Concurrency: DuckDB serialises writes; the worker pool funnels
// per-day commits through a sync.Mutex to avoid two days racing on
// the same primary key.
package script

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"

	_ "github.com/marcboeker/go-duckdb/v2"
)

const (
	schemaSQL = `
CREATE TABLE IF NOT EXISTS builder_daily_aggregates (
    day          DATE      NOT NULL,
    builder      VARCHAR   NOT NULL,
    asset        VARCHAR   NOT NULL,
    volume_usd   DOUBLE    NOT NULL,
    fees_usd     DOUBLE    NOT NULL,
    fill_count   BIGINT    NOT NULL,
    unique_users BIGINT    NOT NULL,
    PRIMARY KEY (day, builder, asset)
);

CREATE TABLE IF NOT EXISTS processed_days (
    day            DATE       PRIMARY KEY,
    processed_at   TIMESTAMP  NOT NULL,
    source         VARCHAR    NOT NULL,
    row_count      BIGINT     NOT NULL,
    builder_count  INTEGER    NOT NULL,
    duration_ms    BIGINT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aggs_builder_day ON builder_daily_aggregates(builder, day);
CREATE INDEX IF NOT EXISTS idx_aggs_day ON builder_daily_aggregates(day);
`
)

// Store wraps the DuckDB handle and a write mutex.
type Store struct {
	db   *sql.DB
	path string
	mu   sync.Mutex
}

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("duckdb", path)
	if err != nil {
		return nil, fmt.Errorf("open duckdb at %s: %w", path, err)
	}
	db.SetMaxOpenConns(1) // DuckDB single-writer model
	if _, err := db.ExecContext(context.Background(), schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{db: db, path: path}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// CommitDay atomically replaces the rows for (day, all builders in
// `rowsByBuilder`) and records a processed_days entry.
func (s *Store) CommitDay(ctx context.Context, day time.Time, source string, rowsByBuilder map[string][]AggRow, duration time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	rollback := func() { _ = tx.Rollback() }

	dayStr := day.UTC().Format("2006-01-02")
	// Wipe + insert per builder so a re-run of the same day is idempotent.
	builders := make([]string, 0, len(rowsByBuilder))
	for b := range rowsByBuilder {
		builders = append(builders, b)
	}
	sort.Strings(builders)

	totalRows := int64(0)
	for _, b := range builders {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM builder_daily_aggregates WHERE day = ? AND builder = ?`,
			dayStr, b); err != nil {
			rollback()
			return fmt.Errorf("delete day=%s builder=%s: %w", dayStr, b, err)
		}
		for _, r := range rowsByBuilder[b] {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO builder_daily_aggregates
                 (day, builder, asset, volume_usd, fees_usd, fill_count, unique_users)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				r.Key.Day, r.Key.Builder, r.Key.Asset,
				r.VolumeUSD, r.FeesUSD, r.FillCount, r.UniqueUsers); err != nil {
				rollback()
				return fmt.Errorf("insert row: %w", err)
			}
			totalRows++
		}
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM processed_days WHERE day = ?`, dayStr); err != nil {
		rollback()
		return fmt.Errorf("delete processed_days: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO processed_days (day, processed_at, source, row_count, builder_count, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
		dayStr, time.Now().UTC(), source, totalRows, len(builders), duration.Milliseconds()); err != nil {
		rollback()
		return fmt.Errorf("insert processed_days: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// OldestProcessedDay returns the smallest day in processed_days, formatted
// as YYYY-MM-DD. Empty string when the table is empty. Mirrors the MAX(day)
// path used by Stats so gap-fill can detect a left-of-range hole.
func (s *Store) OldestProcessedDay(ctx context.Context) (string, error) {
	var oldest sql.NullTime
	if err := s.db.QueryRowContext(ctx,
		`SELECT MIN(day) FROM processed_days`).Scan(&oldest); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if !oldest.Valid {
		return "", nil
	}
	return oldest.Time.UTC().Format("2006-01-02"), nil
}

// IsDayProcessed returns true if processed_days has a row for `day`.
func (s *Store) IsDayProcessed(ctx context.Context, day time.Time) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM processed_days WHERE day = ?`,
		day.UTC().Format("2006-01-02")).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Wipe drops + recreates the schema. Used by `rebuild --confirm`.
func (s *Store) Wipe(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.ExecContext(ctx, `DROP TABLE IF EXISTS builder_daily_aggregates; DROP TABLE IF EXISTS processed_days;`); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, schemaSQL)
	return err
}

// Stats summarises the DB for the health endpoint + Prom gauges.
type Stats struct {
	DBSizeBytes      int64
	BuildersCount    int64
	DaysCount        int64
	LastProcessedDay string // YYYY-MM-DD or ""
	LagHours         float64
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	out := Stats{}
	if fi, err := os.Stat(s.path); err == nil {
		out.DBSizeBytes = fi.Size()
	}
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT builder) FROM builder_daily_aggregates`).Scan(&out.BuildersCount); err != nil {
		return out, err
	}
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT day) FROM builder_daily_aggregates`).Scan(&out.DaysCount); err != nil {
		return out, err
	}
	var last sql.NullTime
	if err := s.db.QueryRowContext(ctx,
		`SELECT MAX(day) FROM processed_days`).Scan(&last); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	if last.Valid {
		out.LastProcessedDay = last.Time.UTC().Format("2006-01-02")
		out.LagHours = time.Since(last.Time.UTC()).Hours()
	}
	return out, nil
}

// QueryBuilderTimeseries returns the per-day rollup for one builder
// over the last `days` days, ordered by day ascending.
func (s *Store) QueryBuilderTimeseries(ctx context.Context, builder string, days int) ([]TimePoint, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT CAST(day AS VARCHAR), SUM(volume_usd), SUM(fees_usd), SUM(fill_count)
         FROM builder_daily_aggregates
         WHERE builder = ? AND day >= CURRENT_DATE - ?::INTEGER
         GROUP BY day ORDER BY day ASC`,
		builder, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TimePoint{}
	for rows.Next() {
		var p TimePoint
		if err := rows.Scan(&p.Day, &p.Vol, &p.Fees, &p.Fills); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// TimePoint is one day in a builder's timeseries.
type TimePoint struct {
	Day   string  `json:"day"`
	Vol   float64 `json:"vol"`
	Fees  float64 `json:"fees"`
	Fills int64   `json:"fills"`
}

// WindowAgg is the rollup over an arbitrary day window.
type WindowAgg struct {
	VolumeUSD float64 `json:"volume_usd"`
	FeesUSD   float64 `json:"fees_usd"`
	Fills     int64   `json:"fills"`
}

// QueryWindowsForAllBuilders returns, for each builder, the rollup over
// each supplied window in days. windowDays must be sorted ascending.
// The returned map is keyed by builder address.
func (s *Store) QueryWindowsForAllBuilders(ctx context.Context, windows map[string]int) (map[string]map[string]WindowAgg, error) {
	out := map[string]map[string]WindowAgg{}
	for label, days := range windows {
		var rows *sql.Rows
		var err error
		if days <= 0 { // "all"
			rows, err = s.db.QueryContext(ctx,
				`SELECT builder, SUM(volume_usd), SUM(fees_usd), SUM(fill_count)
                 FROM builder_daily_aggregates GROUP BY builder`)
		} else {
			rows, err = s.db.QueryContext(ctx,
				`SELECT builder, SUM(volume_usd), SUM(fees_usd), SUM(fill_count)
                 FROM builder_daily_aggregates
                 WHERE day >= CURRENT_DATE - ?::INTEGER
                 GROUP BY builder`, days)
		}
		if err != nil {
			return nil, fmt.Errorf("window %s: %w", label, err)
		}
		for rows.Next() {
			var b string
			var w WindowAgg
			if err := rows.Scan(&b, &w.VolumeUSD, &w.FeesUSD, &w.Fills); err != nil {
				rows.Close()
				return nil, err
			}
			if _, ok := out[b]; !ok {
				out[b] = map[string]WindowAgg{}
			}
			out[b][label] = w
		}
		rows.Close()
	}
	return out, nil
}

// QueryDailyTimeseriesAllBuilders returns per-builder per-day rows for
// the last `days` days (or all-time if days<=0). Bounded so the
// Upstash payload stays under the 1MB Vercel KV ceiling — callers
// should pass days <= 400.
func (s *Store) QueryDailyTimeseriesAllBuilders(ctx context.Context, days int) (map[string][]TimePoint, error) {
	var rows *sql.Rows
	var err error
	if days <= 0 {
		rows, err = s.db.QueryContext(ctx,
			`SELECT builder, CAST(day AS VARCHAR), SUM(volume_usd), SUM(fees_usd), SUM(fill_count)
             FROM builder_daily_aggregates
             GROUP BY builder, day ORDER BY builder, day ASC`)
	} else {
		rows, err = s.db.QueryContext(ctx,
			`SELECT builder, CAST(day AS VARCHAR), SUM(volume_usd), SUM(fees_usd), SUM(fill_count)
             FROM builder_daily_aggregates
             WHERE day >= CURRENT_DATE - ?::INTEGER
             GROUP BY builder, day ORDER BY builder, day ASC`, days)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]TimePoint{}
	for rows.Next() {
		var b string
		var p TimePoint
		if err := rows.Scan(&b, &p.Day, &p.Vol, &p.Fees, &p.Fills); err != nil {
			return nil, err
		}
		out[b] = append(out[b], p)
	}
	return out, rows.Err()
}
