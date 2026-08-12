package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, connStr string) (*DB, error) {
	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		return nil, fmt.Errorf("store: connect: %w", err)
	}
	return &DB{pool: pool}, nil
}

func (db *DB) Close() { db.pool.Close() }

func (db *DB) Pool() *pgxpool.Pool { return db.pool }

// ExecEvent is a parsed Solana transaction from a monitored platform.
type ExecEvent struct {
	Sig                 string
	Platform            string
	Slot                uint64
	BlockTime           time.Time
	TotalFeeLamports    int64
	PriorityFeeLamports int64
	PlatformFeeLamports int64
	IsJitoBundle        bool
	JitoTipLamports     int64
	CUConsumed          int64
	CUPriceMicro        int64
}

// UpsertEvents inserts exec events idempotently; existing sigs are skipped.
func (db *DB) UpsertEvents(ctx context.Context, events []ExecEvent) error {
	if len(events) == 0 {
		return nil
	}
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, e := range events {
		_, err := tx.Exec(ctx, `
			INSERT INTO solana_exec_events
				(sig, platform, slot, block_time,
				 total_fee_lamports, priority_fee_lamports, platform_fee_lamports,
				 is_jito_bundle, jito_tip_lamports, cu_consumed, cu_price_micro)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT (sig) DO NOTHING`,
			e.Sig, e.Platform, e.Slot, e.BlockTime,
			e.TotalFeeLamports, e.PriorityFeeLamports, e.PlatformFeeLamports,
			e.IsJitoBundle, e.JitoTipLamports, e.CUConsumed, e.CUPriceMicro,
		)
		if err != nil {
			return fmt.Errorf("store: upsert %s: %w", e.Sig, err)
		}
	}
	return tx.Commit(ctx)
}

// Cursor holds the last processed signature for a fee account.
type Cursor struct {
	LastSig string
	Slot    uint64
}

func (db *DB) GetCursor(ctx context.Context, platform string) (Cursor, error) {
	var c Cursor
	err := db.pool.QueryRow(ctx,
		`SELECT last_sig, slot FROM solana_exec_cursors WHERE platform = $1`, platform,
	).Scan(&c.LastSig, &c.Slot)
	if err != nil {
		return Cursor{}, nil // no cursor yet = start from recent
	}
	return c, nil
}

func (db *DB) SaveCursor(ctx context.Context, platform, lastSig string, slot uint64) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO solana_exec_cursors (platform, last_sig, slot, updated_at)
		VALUES ($1,$2,$3,now())
		ON CONFLICT (platform) DO UPDATE SET
			last_sig=EXCLUDED.last_sig, slot=EXCLUDED.slot, updated_at=now()`,
		platform, lastSig, slot,
	)
	return err
}

// UpsertRawCounts stores hourly successful-tx counts from raw sig pagination.
// fromCursor is cursor.LastSig at poll start — makes each row idempotent:
// same (platform, bucket_start, fromCursor) on retry → DO NOTHING, no double-count.
func (db *DB) UpsertRawCounts(ctx context.Context, platform, fromCursor string, counts map[time.Time]int64) error {
	if len(counts) == 0 {
		return nil
	}
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	for bucket, count := range counts {
		_, err := tx.Exec(ctx, `
			INSERT INTO solana_exec_raw_counts (platform, bucket_start, from_cursor, success_count, updated_at)
			VALUES ($1, $2, $3, $4, now())
			ON CONFLICT (platform, bucket_start, from_cursor) DO NOTHING`,
			platform, bucket, fromCursor, count,
		)
		if err != nil {
			return fmt.Errorf("store: upsert raw count %v: %w", bucket, err)
		}
	}
	return tx.Commit(ctx)
}

// CUSample is a single compute-unit price observation from the enhanced API sample.
type CUSample struct {
	Sig          string
	BlockTime    time.Time
	CUPriceMicro int64
}

// InsertCUSamples stores CU price samples idempotently keyed on (platform, sig).
func (db *DB) InsertCUSamples(ctx context.Context, platform string, samples []CUSample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	defer tx.Rollback(ctx)
	for _, s := range samples {
		_, err := tx.Exec(ctx,
			`INSERT INTO solana_exec_cu_samples (platform, sig, block_time, cu_price_micro)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (platform, sig) DO NOTHING`,
			platform, s.Sig, s.BlockTime, s.CUPriceMicro,
		)
		if err != nil {
			return fmt.Errorf("store: insert cu sample %s: %w", s.Sig, err)
		}
	}
	return tx.Commit(ctx)
}

// PurgeCUSamples deletes samples older than 35 days to bound table growth.
func (db *DB) PurgeCUSamples(ctx context.Context) error {
	_, err := db.pool.Exec(ctx, `DELETE FROM solana_exec_cu_samples WHERE block_time < now() - INTERVAL '35 days'`)
	return err
}

// PurgeEvents deletes sampled events older than 90 days.
func (db *DB) PurgeEvents(ctx context.Context) error {
	_, err := db.pool.Exec(ctx, `DELETE FROM solana_exec_events WHERE block_time < now() - INTERVAL '90 days'`)
	return err
}

// Materialize recomputes hourly facts for the given platform.
// tx_count comes from solana_exec_raw_counts (full volume); fee metrics come
// from the sampled solana_exec_events (representative quality metrics).
func (db *DB) Materialize(ctx context.Context, platform string) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO solana_exec_facts
			(platform, bucket_start, tx_count,
			 avg_priority_fee_lamports, p50_cu_price_micro, p95_cu_price_micro,
			 avg_platform_fee_lamports, sum_platform_fee_lamports, jito_rate, avg_cu_consumed, computed_at)
		SELECT
			e.platform,
			date_trunc('hour', e.block_time) AS bucket_start,
			COALESCE(r.success_count, COUNT(*)) AS tx_count,
			AVG(e.priority_fee_lamports) AS avg_priority_fee_lamports,
			COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY e.cu_price_micro) FILTER (WHERE e.cu_price_micro > 0), 0) AS p50_cu_price_micro,
			COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY e.cu_price_micro) FILTER (WHERE e.cu_price_micro > 0), 0) AS p95_cu_price_micro,
			AVG(e.platform_fee_lamports) AS avg_platform_fee_lamports,
			SUM(e.platform_fee_lamports) AS sum_platform_fee_lamports,
			AVG(CASE WHEN e.is_jito_bundle THEN 1.0 ELSE 0.0 END) AS jito_rate,
			AVG(e.cu_consumed) AS avg_cu_consumed,
			now()
		FROM solana_exec_events e
		LEFT JOIN (
			SELECT platform, bucket_start, SUM(success_count) AS success_count
			FROM solana_exec_raw_counts
			GROUP BY platform, bucket_start
		) r ON r.platform = e.platform AND r.bucket_start = date_trunc('hour', e.block_time)
		WHERE e.platform = $1
		GROUP BY e.platform, date_trunc('hour', e.block_time), r.success_count
		ON CONFLICT (platform, bucket_start) DO UPDATE SET
			tx_count = EXCLUDED.tx_count,
			avg_priority_fee_lamports = EXCLUDED.avg_priority_fee_lamports,
			p50_cu_price_micro = EXCLUDED.p50_cu_price_micro,
			p95_cu_price_micro = EXCLUDED.p95_cu_price_micro,
			avg_platform_fee_lamports = EXCLUDED.avg_platform_fee_lamports,
			sum_platform_fee_lamports = EXCLUDED.sum_platform_fee_lamports,
			jito_rate = EXCLUDED.jito_rate,
			avg_cu_consumed = EXCLUDED.avg_cu_consumed,
			computed_at = now()`,
		platform,
	)
	return err
}
