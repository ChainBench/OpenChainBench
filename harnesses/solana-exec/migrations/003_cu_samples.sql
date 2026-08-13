BEGIN;

-- Raw CU price samples from the 100-sig enhanced API poll each cycle.
-- Gives real percentile_cont on actual data points instead of AVG(hourly_p50).
-- Retention: 35 days (purged by materializer).
CREATE TABLE IF NOT EXISTS solana_exec_cu_samples (
    id             BIGSERIAL PRIMARY KEY,
    platform       TEXT NOT NULL,
    block_time     TIMESTAMPTZ NOT NULL,
    cu_price_micro BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS solana_exec_cu_samples_platform_time
    ON solana_exec_cu_samples (platform, block_time);

COMMIT;
