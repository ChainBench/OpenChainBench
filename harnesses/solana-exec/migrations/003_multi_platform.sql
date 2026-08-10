BEGIN;

-- Add from_cursor to raw_counts for idempotency: same poll window = same from_cursor = DO NOTHING on retry.
-- Drop and recreate: table is ephemeral (rolling window, recomputable) so truncate is safe.
TRUNCATE solana_exec_raw_counts;
ALTER TABLE solana_exec_raw_counts
    ADD COLUMN IF NOT EXISTS from_cursor TEXT NOT NULL DEFAULT '';
ALTER TABLE solana_exec_raw_counts
    DROP CONSTRAINT IF EXISTS solana_exec_raw_counts_pkey;
ALTER TABLE solana_exec_raw_counts
    ADD PRIMARY KEY (platform, bucket_start, from_cursor);

-- Per-account cursors: key was platform, now platform:feeAccount.
-- Existing single-account cursors (key = platform name) stay valid for pump.fun.
-- No migration needed; old key will not match new compound keys — polls restart from tip for new accounts.

-- CU price samples for rolling percentile metrics (35-day retention).
CREATE TABLE IF NOT EXISTS solana_exec_cu_samples (
    platform       TEXT NOT NULL,
    sig            TEXT NOT NULL,
    block_time     TIMESTAMPTZ NOT NULL,
    cu_price_micro BIGINT NOT NULL,
    PRIMARY KEY (platform, sig)
);

CREATE INDEX IF NOT EXISTS solana_exec_cu_samples_bt
    ON solana_exec_cu_samples (platform, block_time DESC);

COMMIT;
