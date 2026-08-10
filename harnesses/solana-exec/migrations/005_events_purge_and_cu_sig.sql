BEGIN;

-- Bound events table growth: materializer will purge rows older than 90 days.
-- Facts table already holds all aggregated metrics; raw events are only needed
-- for re-materialization within the rolling window.
-- No schema change needed — purge is done in application code.

-- Make cu_samples idempotent on crash/restart by keying on (platform, sig).
-- Without this, a crash between UpsertEvents and SaveCursor causes the next
-- boot to re-call InsertCUSamples for the same 100 sigs, duplicating them
-- and slightly skewing percentiles.
ALTER TABLE solana_exec_cu_samples ADD COLUMN IF NOT EXISTS sig TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS solana_exec_cu_samples_platform_sig
    ON solana_exec_cu_samples (platform, sig)
    WHERE sig IS NOT NULL;

COMMIT;
