BEGIN;

-- Hourly raw successful-tx counts derived from getSignaturesForAddress pagination.
-- Counted at zero extra Helius credit cost (no enhanced API needed).
-- Separate from solana_exec_events which only holds fee-quality sampled rows.
CREATE TABLE IF NOT EXISTS solana_exec_raw_counts (
    platform      TEXT NOT NULL,
    bucket_start  TIMESTAMPTZ NOT NULL,
    success_count BIGINT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, bucket_start)
);

-- Replace tx_count (INT) in facts with BIGINT to hold real volumes.
ALTER TABLE solana_exec_facts
    ALTER COLUMN tx_count TYPE BIGINT;

COMMIT;
