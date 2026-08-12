BEGIN;

-- Exact per-bucket fee sum, populated by Materialize().
-- Replaces the extrapolation txCount × avg_platform_fee when events are complete.
ALTER TABLE solana_exec_facts
    ADD COLUMN IF NOT EXISTS sum_platform_fee_lamports BIGINT NOT NULL DEFAULT 0;

COMMIT;
