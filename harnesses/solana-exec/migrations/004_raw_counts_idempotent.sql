BEGIN;

-- Make raw_counts idempotent on crash/restart.
-- Problem: UpsertRawCounts accumulated (success_count + EXCLUDED.success_count).
-- On a crash between UpsertRawCounts and SaveCursor, the next boot re-processes
-- the same sigs and double-counts. Fix: key by (platform, bucket_start, from_cursor)
-- so each poll's contribution is a distinct row. ON CONFLICT DO NOTHING = fully idempotent.

ALTER TABLE solana_exec_raw_counts DROP CONSTRAINT solana_exec_raw_counts_pkey;

-- from_cursor = cursor.LastSig at the start of the poll that produced this row.
-- Existing rows get '' which is safe — they predate this schema change and won't be re-inserted.
ALTER TABLE solana_exec_raw_counts ADD COLUMN IF NOT EXISTS from_cursor TEXT NOT NULL DEFAULT '';

ALTER TABLE solana_exec_raw_counts ADD PRIMARY KEY (platform, bucket_start, from_cursor);

COMMIT;
