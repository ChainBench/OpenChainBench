CREATE TABLE IF NOT EXISTS evm_exec_events (
    id           BIGSERIAL PRIMARY KEY,
    chain        TEXT NOT NULL,
    tx_hash      TEXT NOT NULL,
    block_num    BIGINT NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    platform     TEXT NOT NULL,
    asset        TEXT NOT NULL,
    amount_raw   NUMERIC(78,0) NOT NULL,
    decimals     INT NOT NULL,
    -- intra-tx discriminator: log_index for ERC-20, traceId for Etherscan internal,
    -- position index for NodeReal transfers, "" for plain value txs.
    event_key    TEXT NOT NULL,
    UNIQUE (chain, tx_hash, asset, event_key)
);

CREATE INDEX IF NOT EXISTS idx_evm_events_lookup
    ON evm_exec_events (platform, chain, block_time DESC);

CREATE TABLE IF NOT EXISTS evm_block_times (
    chain      TEXT NOT NULL,
    block_num  BIGINT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain, block_num)
);

-- No DEFAULT on last_block: the collector seeds from bootstrap on first run.
CREATE TABLE IF NOT EXISTS evm_exec_cursors (
    chain       TEXT NOT NULL,
    platform    TEXT NOT NULL,
    asset       TEXT NOT NULL,
    last_block  BIGINT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain, platform, asset)
);

CREATE TABLE IF NOT EXISTS evm_exec_facts (
    chain           TEXT NOT NULL,
    platform        TEXT NOT NULL,
    bucket_start    TIMESTAMPTZ NOT NULL,
    revenue_stable  NUMERIC NOT NULL DEFAULT 0,
    revenue_native  NUMERIC NOT NULL DEFAULT 0,
    native_symbol   TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain, platform, bucket_start)
);
