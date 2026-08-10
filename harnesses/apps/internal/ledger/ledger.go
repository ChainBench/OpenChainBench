package ledger

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ChainBench/OpenChainBench/harnesses/apps/internal/spec"
)

type DB struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, connStr string) (*DB, error) {
	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		return nil, fmt.Errorf("ledger: connect: %w", err)
	}
	return &DB{pool: pool}, nil
}

func (db *DB) Close() { db.pool.Close() }

// UpsertEvents inserts fee events idempotently.
// A duplicate (deployment_id, event_key, beneficiary) is silently ignored.
func (db *DB) UpsertEvents(ctx context.Context, events []spec.FeeEvent) error {
	if len(events) == 0 {
		return nil
	}

	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("ledger: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, e := range events {
		_, err := tx.Exec(ctx, `
			INSERT INTO fee_events
				(deployment_id, event_key, beneficiary, ts, height,
				 component, token, amount_raw, decimals, market,
				 finality, source, meta)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13)
			ON CONFLICT (deployment_id, event_key, beneficiary) DO NOTHING`,
			e.DeploymentID, e.EventKey, e.Beneficiary, e.Ts, e.Height,
			e.Component, e.Token, e.AmountRaw, e.Decimals, e.Market,
			string(e.Finality), e.Source, metaToJSON(e.Meta),
		)
		if err != nil {
			return fmt.Errorf("ledger: upsert event %s: %w", e.EventKey, err)
		}
	}

	return tx.Commit(ctx)
}

// GetCursor returns the last known cursor for a deployment.
func (db *DB) GetCursor(ctx context.Context, deploymentID string) (spec.Cursor, error) {
	var c spec.Cursor
	err := db.pool.QueryRow(ctx, `
		SELECT height, COALESCE(block_hash,''), ts, finalized
		FROM collector_cursors WHERE deployment_id = $1`, deploymentID,
	).Scan(&c.Height, &c.BlockHash, &c.Ts, &c.Finalized)
	if err != nil {
		return spec.Cursor{}, nil // no cursor yet = start from genesis
	}
	return c, nil
}

// SaveCursor upserts the cursor after a successful batch.
func (db *DB) SaveCursor(ctx context.Context, deploymentID string, c spec.Cursor) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO collector_cursors (deployment_id, height, block_hash, ts, finalized, updated_at)
		VALUES ($1,$2,$3,$4,$5,now())
		ON CONFLICT (deployment_id) DO UPDATE SET
			height=EXCLUDED.height, block_hash=EXCLUDED.block_hash,
			ts=EXCLUDED.ts, finalized=EXCLUDED.finalized, updated_at=now()`,
		deploymentID, c.Height, c.BlockHash, c.Ts, c.Finalized,
	)
	return err
}

// Pool exposes the underlying pool for the invariant checker.
func (db *DB) Pool() *pgxpool.Pool { return db.pool }

// Materialize computes fee_facts from fee_events for a deployment.
// Prices are stored as 1.0 for USDC (stable_passthrough); extend for non-stable tokens.
func (db *DB) Materialize(ctx context.Context, deploymentID string, mv int) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO fee_facts
			(deployment_id, bucket_start, methodology_version,
			 component, beneficiary, token,
			 amount_native, price_usd, price_source, price_ts, price_confidence,
			 amount_usd, event_count, finality)
		SELECT
			deployment_id,
			date_trunc('hour', ts)          AS bucket_start,
			$2                              AS methodology_version,
			component,
			beneficiary,
			token,
			SUM(amount_raw::numeric / POW(10, decimals)) AS amount_native,
			1.0                             AS price_usd,
			'stable_passthrough'            AS price_source,
			date_trunc('hour', ts)          AS price_ts,
			'high'                          AS price_confidence,
			SUM(amount_raw::numeric / POW(10, decimals)) AS amount_usd,
			COUNT(*)                        AS event_count,
			MIN(finality)                   AS finality
		FROM fee_events
		WHERE deployment_id = $1
		GROUP BY deployment_id, date_trunc('hour', ts), component, beneficiary, token
		ON CONFLICT (deployment_id, bucket_start, methodology_version, component, beneficiary, token)
		DO UPDATE SET
			amount_native = EXCLUDED.amount_native,
			amount_usd    = EXCLUDED.amount_usd,
			event_count   = EXCLUDED.event_count,
			finality      = EXCLUDED.finality`,
		deploymentID, mv,
	)
	return err
}

// Quarantine inserts a quarantine record for a deployment bucket.
func (db *DB) Quarantine(ctx context.Context, deploymentID, reason string) error {
	_, err := db.pool.Exec(ctx, `
		INSERT INTO quarantine (deployment_id, bucket_start, reason, opened_at)
		VALUES ($1, date_trunc('hour', now()), $2, now())
		ON CONFLICT (deployment_id, bucket_start, reason) DO NOTHING`,
		deploymentID, reason,
	)
	return err
}

// RefreshMaterializedView refreshes fee_facts_windowed.
func (db *DB) RefreshMaterializedView(ctx context.Context) error {
	_, err := db.pool.Exec(ctx, `REFRESH MATERIALIZED VIEW CONCURRENTLY fee_facts_windowed`)
	return err
}

func metaToJSON(m map[string]string) interface{} {
	if len(m) == 0 {
		return nil
	}
	return m
}
