package store

import (
	"context"
	"fmt"
	"math/big"
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

// EVMEvent is one fee inflow to a platform's fee collector.
type EVMEvent struct {
	Chain     string
	TxHash    string
	BlockNum  uint64
	BlockTime time.Time
	Platform  string
	Asset     string   // "native" or token contract (lowercase)
	AmountRaw *big.Int // wei or raw token units; never divided in Go
	Decimals  int
	EventKey  string // log_index / traceId / transfer index / ""
}

// UpsertEvent inserts an EVM fee event; skips silently on (chain,tx_hash,asset,event_key) conflict.
func (db *DB) UpsertEvent(ctx context.Context, e EVMEvent) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO evm_exec_events
			(chain, tx_hash, block_num, block_time, platform, asset, amount_raw, decimals, event_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7::NUMERIC,$8,$9)
		ON CONFLICT (chain, tx_hash, asset, event_key) DO NOTHING`,
		e.Chain, e.TxHash, e.BlockNum, e.BlockTime,
		e.Platform, e.Asset, e.AmountRaw.String(), e.Decimals, e.EventKey,
	)
	if err != nil {
		return fmt.Errorf("store: upsert %s/%s: %w", e.Chain, e.TxHash, err)
	}
	return nil
}

// UpsertEvents bulk-upserts in a single transaction.
func (db *DB) UpsertEvents(ctx context.Context, events []EVMEvent) error {
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
			INSERT INTO evm_exec_events
				(chain, tx_hash, block_num, block_time, platform, asset, amount_raw, decimals, event_key)
			VALUES ($1,$2,$3,$4,$5,$6,$7::NUMERIC,$8,$9)
			ON CONFLICT (chain, tx_hash, asset, event_key) DO NOTHING`,
			e.Chain, e.TxHash, e.BlockNum, e.BlockTime,
			e.Platform, e.Asset, e.AmountRaw.String(), e.Decimals, e.EventKey,
		)
		if err != nil {
			return fmt.Errorf("store: upsert %s/%s: %w", e.Chain, e.TxHash, err)
		}
	}
	return tx.Commit(ctx)
}

// GetCursor returns the last processed block for (chain, platform, asset).
// Returns (0, false, nil) when no cursor exists yet.
func (db *DB) GetCursor(ctx context.Context, chain, platform, asset string) (uint64, bool, error) {
	var lastBlock uint64
	err := db.pool.QueryRow(ctx,
		`SELECT last_block FROM evm_exec_cursors WHERE chain=$1 AND platform=$2 AND asset=$3`,
		chain, platform, asset,
	).Scan(&lastBlock)
	if err != nil {
		return 0, false, nil
	}
	return lastBlock, true, nil
}

// SaveCursor upserts the last processed block.
func (db *DB) SaveCursor(ctx context.Context, chain, platform, asset string, lastBlock uint64) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO evm_exec_cursors (chain, platform, asset, last_block, updated_at)
		VALUES ($1,$2,$3,$4,now())
		ON CONFLICT (chain, platform, asset) DO UPDATE SET
			last_block = EXCLUDED.last_block, updated_at = now()`,
		chain, platform, asset, lastBlock,
	)
	return err
}

// SeedCursorIfAbsent inserts a bootstrap cursor only when none exists (DO NOTHING on conflict).
func (db *DB) SeedCursorIfAbsent(ctx context.Context, chain, platform, asset string, bootstrapBlock uint64) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO evm_exec_cursors (chain, platform, asset, last_block, updated_at)
		VALUES ($1,$2,$3,$4,now())
		ON CONFLICT (chain, platform, asset) DO NOTHING`,
		chain, platform, asset, bootstrapBlock,
	)
	return err
}

// GetBlockTime returns a cached block timestamp, if present.
func (db *DB) GetBlockTime(ctx context.Context, chain string, blockNum uint64) (time.Time, bool) {
	var t time.Time
	err := db.pool.QueryRow(ctx,
		`SELECT block_time FROM evm_block_times WHERE chain=$1 AND block_num=$2`,
		chain, blockNum,
	).Scan(&t)
	return t, err == nil
}

// CacheBlockTime writes a block timestamp to the local cache table.
func (db *DB) CacheBlockTime(ctx context.Context, chain string, blockNum uint64, t time.Time) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO evm_block_times (chain, block_num, block_time)
		VALUES ($1,$2,$3)
		ON CONFLICT (chain, block_num) DO NOTHING`,
		chain, blockNum, t,
	)
	return err
}

// Materialize recomputes hourly revenue facts from the last 31 days of events.
func (db *DB) Materialize(ctx context.Context) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO evm_exec_facts
			(chain, platform, bucket_start, revenue_stable, revenue_native, native_symbol, updated_at)
		SELECT
			chain,
			platform,
			date_trunc('hour', block_time) AS bucket_start,
			COALESCE(SUM(amount_raw::numeric / (10::numeric ^ decimals)) FILTER (WHERE asset <> 'native'), 0),
			COALESCE(SUM(amount_raw::numeric / (10::numeric ^ decimals)) FILTER (WHERE asset  = 'native'), 0),
			CASE WHEN chain = 'bsc' THEN 'BNB' ELSE 'ETH' END,
			now()
		FROM evm_exec_events
		WHERE block_time > now() - INTERVAL '31 days'
		GROUP BY 1, 2, 3
		ON CONFLICT (chain, platform, bucket_start) DO UPDATE SET
			revenue_stable = EXCLUDED.revenue_stable,
			revenue_native = EXCLUDED.revenue_native,
			native_symbol  = EXCLUDED.native_symbol,
			updated_at     = now()`,
	)
	return err
}

// RevenueRow is one (chain, platform) 24h revenue aggregate.
type RevenueRow struct {
	Chain          string
	Platform       string
	RevenueStable  float64
	RevenueNative  float64
	NativeSymbol   string
}

// GetRevenue24h returns aggregated revenue for the last 24h per (chain, platform).
func (db *DB) GetRevenue24h(ctx context.Context) ([]RevenueRow, error) {
	rows, err := db.pool.Query(ctx, `
		SELECT chain, platform,
		       COALESCE(SUM(revenue_stable), 0),
		       COALESCE(SUM(revenue_native), 0),
		       COALESCE(MAX(native_symbol), '')
		FROM evm_exec_facts
		WHERE bucket_start >= now() - INTERVAL '24 hours'
		GROUP BY chain, platform`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []RevenueRow
	for rows.Next() {
		var r RevenueRow
		if err := rows.Scan(&r.Chain, &r.Platform, &r.RevenueStable, &r.RevenueNative, &r.NativeSymbol); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
