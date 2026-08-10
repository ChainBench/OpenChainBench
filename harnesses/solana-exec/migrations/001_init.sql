BEGIN;

-- Raw events. One row per transaction that touched a monitored platform fee account.
-- Immutable: only upsert, never update. sig is globally unique on Solana.
CREATE TABLE IF NOT EXISTS solana_exec_events (
    sig                   TEXT PRIMARY KEY,
    platform              TEXT NOT NULL,
    slot                  BIGINT NOT NULL,
    block_time            TIMESTAMPTZ NOT NULL,
    -- fee = base + priority. Base ≈ 5000 lamports × num_signers.
    total_fee_lamports    BIGINT NOT NULL DEFAULT 0,
    priority_fee_lamports BIGINT NOT NULL DEFAULT 0,
    -- SOL transferred to the platform's fee account in this tx.
    platform_fee_lamports BIGINT NOT NULL DEFAULT 0,
    is_jito_bundle        BOOLEAN NOT NULL DEFAULT false,
    jito_tip_lamports     BIGINT NOT NULL DEFAULT 0,
    cu_consumed           BIGINT NOT NULL DEFAULT 0,
    -- microlamports per CU (from ComputeBudget instruction if present)
    cu_price_micro        BIGINT NOT NULL DEFAULT 0,
    ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS solana_exec_events_platform_bt
    ON solana_exec_events (platform, block_time DESC);

-- Derived hourly facts. Recomputable from solana_exec_events at any time.
CREATE TABLE IF NOT EXISTS solana_exec_facts (
    platform                  TEXT NOT NULL,
    bucket_start              TIMESTAMPTZ NOT NULL,  -- truncated to 1h
    tx_count                  INT NOT NULL DEFAULT 0,
    avg_priority_fee_lamports DOUBLE PRECISION NOT NULL DEFAULT 0,
    p50_cu_price_micro        DOUBLE PRECISION NOT NULL DEFAULT 0,
    p95_cu_price_micro        DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_platform_fee_lamports DOUBLE PRECISION NOT NULL DEFAULT 0,
    jito_rate                 DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_cu_consumed           DOUBLE PRECISION NOT NULL DEFAULT 0,
    computed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, bucket_start)
);

-- Cursor per platform: tracks last-seen signature to enable incremental polling.
CREATE TABLE IF NOT EXISTS solana_exec_cursors (
    platform   TEXT PRIMARY KEY,
    last_sig   TEXT NOT NULL,
    slot       BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
