# hl-archive

Historical Hyperliquid builder-fee archive: backfill once, ship a clean Upstash snapshot every day at 02:00 UTC.

## What it does

`hl-archive` walks the public Hyperliquid CDN (`stats-data.hyperliquid.xyz/Mainnet/builder_fills/...`), decompresses one `.csv.lz4` per (builder, day), and folds each fill into a per-day per-builder per-asset aggregate stored in a local DuckDB file. It exposes the aggregates on an HTTP API (auth-gated by `X-API-Key`) and pushes a compact JSON snapshot to Upstash KV so the OCB Next.js app can render windowed leaderboards (24 h / 7 d / 30 d / 90 d / 180 d / 1 y / all) without ever talking to the CDN itself. An in-process cron triggers daily at 02:00 UTC (configurable) to parse J-1 and refresh the snapshot.

## Architecture

```text
                  daily 02:00 UTC
                        |
                        v
[HL public CDN] -> [hl-archive Go service] -> [DuckDB /data/history.duckdb]
   .csv.lz4               (parse + agg)               |
                                |                     v
                                |             [/v1/aggregates HTTP API]
                                v
                       [Upstash KV: ocb:hl-archive:v1]
                                |
                                v
                       [OCB Next.js on Vercel]
```

## Quick start

```bash
docker build -t hl-archive .
docker run --rm -p 2114:2114 \
  -v "$PWD/data:/data" \
  -e HL_ARCHIVE_API_KEY=local-dev-key \
  -e HL_ARCHIVE_DB_PATH=/data/history.duckdb \
  -e HL_ARCHIVE_BUILDERS_FILE=/app/data/builders.json \
  hl-archive serve
```

Upstash is optional in dev: leave `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` unset and the push step logs a warning and continues (see `script/upstash.go`). To get real data into the DB, run a backfill in a second shell:

```bash
docker exec -it $(docker ps -qf ancestor=hl-archive) \
  hl-archive backfill --from 2025-08-01 --to 2025-08-03
```

Then hit the API:

```bash
curl http://localhost:2114/health
curl -H 'X-API-Key: local-dev-key' \
  'http://localhost:2114/v1/aggregates?window=30d'
```

## CLI reference

```text
hl-archive <subcommand> [flags]
```

| Subcommand | Purpose |
|---|---|
| `backfill` | Parse a date range from the CDN into DuckDB. Idempotent; days already in `processed_days` are skipped, replays of a day overwrite its rows. Flags: `--from YYYY-MM-DD --to YYYY-MM-DD [--workers 16]`. |
| `daily` | Parse J-1 (yesterday UTC) for every builder in `builders.json`, then push the snapshot to Upstash. Same as one cron tick. Takes no flags. |
| `rebuild` | Drop the aggregate tables and re-backfill the full coverage window (`HL_ARCHIVE_BACKFILL_FROM` to J-1). Destructive; requires `--confirm`. |
| `serve` | Long-running mode: HTTP API on `:2114`, Prom metrics on `/metrics`, in-process cron at `HL_ARCHIVE_CRON_HOUR` UTC. `HL_ARCHIVE_API_KEY` is required. Takes no flags. |
| `query` | Ad-hoc DuckDB query for one builder's per-day timeseries, prints JSON to stdout. Flags: `--builder 0x... [--days 30]`. Read-only. |

All subcommands honour `LOG_LEVEL` (`debug` / `info` / `warn` / `error`). `info` is the default.

## Environment variables

| Name | Default | Required | Meaning |
|---|---|---|---|
| `HL_ARCHIVE_DB_PATH` | `/data/history.duckdb` | no | Path to the DuckDB file. Parent dir created on demand, must be writable. |
| `HL_ARCHIVE_BUILDERS_FILE` | `./data/builders.json` | no | Path to the builder registry JSON. |
| `HL_ARCHIVE_HTTP_ADDR` | `0.0.0.0:2114` | no | HTTP listen address for `serve`. |
| `HL_ARCHIVE_API_KEY` | (none) | yes for `serve` | Shared secret. `/v1/aggregates` requires `X-API-Key: <value>`. `/health` and `/metrics` stay open. |
| `HL_ARCHIVE_CRON_HOUR` | `2` | no | Hour of day (UTC, 0-23) at which the in-process cron fires inside `serve`. |
| `HL_ARCHIVE_BACKFILL_FROM` | `2025-08-01` | no | Earliest day `rebuild` walks back to. |
| `HL_ARCHIVE_UPSTASH_KEY` | `ocb:hl-archive:v1` | no | Key the snapshot is written to. Bump the suffix when the JSON shape changes. |
| `UPSTASH_REDIS_REST_URL` | (none) | no, but push is skipped without it | Upstash REST endpoint, e.g. `https://us1-foo-12345.upstash.io`. |
| `UPSTASH_REDIS_REST_TOKEN` | (none) | no, but push is skipped without it | Upstash REST token (read+write). |
| `LOG_LEVEL` | `info` | no | `debug` / `info` / `warn` / `error`. |

## API reference

### `GET /health`

Open, no auth.

```bash
curl https://hl-archive-production.up.railway.app/health
```

```json
{
  "status": "ok",
  "last_processed_day": "2026-06-24",
  "lag_hours": 18.4,
  "db_size_bytes": 41943040,
  "builders_count": 104,
  "days_count": 329,
  "version": "1.0.0"
}
```

`status` flips to `degraded` when the store query errors or `lag_hours > 48`. HTTP code is always 200 (alerting is driven by `hl_archive_lag_hours`, not the HTTP status).

### `GET /v1/aggregates`

Auth-gated. Send `X-API-Key: <HL_ARCHIVE_API_KEY>`. Returns 401 otherwise.

```bash
curl -H "X-API-Key: $HL_ARCHIVE_API_KEY" \
  'https://hl-archive-production.up.railway.app/v1/aggregates?window=30d'
```

Query params:

| Name | Values | Default | Meaning |
|---|---|---|---|
| `window` | `24h` / `7d` / `30d` / `90d` / `180d` / `1y` / `all` | `all` (400 days of timeseries) | Caps the per-builder daily timeseries length; the `windows` map is always populated for every window. |

Response shape (`UpstashPayload`):

```json
{
  "updated_at": "2026-06-25T02:00:01Z",
  "builders": {
    "0xb84168cf3be63c6b8dad05ff5d755e97432ff80b": {
      "name": "Phantom",
      "windows": {
        "24h":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "7d":   { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "30d":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "90d":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "180d": { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "1y":   { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "all":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 }
      },
      "timeseries_daily": [
        { "day": "2026-05-26", "vol": 1234.56, "fees": 0.12, "fills": 8 }
      ]
    }
  }
}
```

The keys of `builders` are the lowercased 0x addresses from `builders.json`. Derived ratios (effective fee bps, $ per user) live downstream in the OCB Next.js reader, not in this payload.

### `GET /metrics`

Standard Prometheus exposition, open, no auth. Scraped by the shared `openchainbench-monitoring` Prometheus at `hl-archive.railway.internal:2114`.

## Prometheus metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `hl_archive_last_run_unix_seconds` | gauge | | Unix ts of the last completed daily-cron tick. |
| `hl_archive_files_processed_total` | counter | `source`, `result` | CDN files fetched. `source` is always `cdn` (single fetcher today); `result` is `ok` / `notfound` / `error`. The per-run provenance (daily vs backfill) lives in the `source` column of `processed_days`, not in this metric. |
| `hl_archive_db_size_bytes` | gauge | | Size of the DuckDB file. Climbs ~150 KB/day at steady state. |
| `hl_archive_builders_count` | gauge | | Distinct builders with at least one row in `builder_daily_aggregates`. |
| `hl_archive_days_count` | gauge | | Distinct days in `builder_daily_aggregates`. |
| `hl_archive_lag_hours` | gauge | | Hours between now and the most recent processed day. Should sit between 18 h and 30 h in steady state. |
| `hl_archive_upstash_push_duration_seconds` | histogram | | Wall-clock duration of the Upstash REST push. p95 < 1 s in steady state. |
| `hl_archive_cron_runs_total` | counter | `result` | Internal daily-cron firings. `result` is `ok` / `err`. |
| `hl_archive_http_requests_total` | counter | `path`, `code` | API request counts by route and HTTP status. |

## Where the data goes

### DuckDB schema

```text
builder_daily_aggregates
+--------------+---------+--------------------------------------+
| column       | type    | meaning                              |
+--------------+---------+--------------------------------------+
| day          | DATE    | UTC day (PK part 1)                  |
| builder      | VARCHAR | lowercased 0x... (PK part 2)         |
| asset        | VARCHAR | coin symbol (PK part 3)              |
| volume_usd   | DOUBLE  | sum(px * sz) over the day            |
| fees_usd     | DOUBLE  | sum(builder_fee) over the day        |
| fill_count   | BIGINT  | row count                            |
| unique_users | BIGINT  | count distinct user                  |
+--------------+---------+--------------------------------------+
PRIMARY KEY (day, builder, asset)
INDEX idx_aggs_builder_day (builder, day)
INDEX idx_aggs_day (day)

processed_days
+---------------+-----------+----------------------------+
| column        | type      | meaning                    |
+---------------+-----------+----------------------------+
| day           | DATE      | PK                         |
| processed_at  | TIMESTAMP | when CommitDay finished    |
| source        | VARCHAR   | "daily" / "backfill"       |
| row_count     | BIGINT    | aggregate rows written     |
| builder_count | INTEGER   | builders that returned 200 |
| duration_ms   | BIGINT    | wall-clock of the day      |
+---------------+-----------+----------------------------+
```

`processed_days` is the source of truth for `last_processed_day` and `lag_hours`. The `builders` registry lives in `data/builders.json`, not in the DB; it is loaded once per process and on each `backfill` / `daily` invocation.

### Upstash KV snapshot shape

Key: `ocb:hl-archive:v1` (override with `HL_ARCHIVE_UPSTASH_KEY`).

```json
{
  "updated_at": "2026-06-25T02:00:01Z",
  "builders": {
    "0x...": {
      "name": "...",
      "windows": {
        "24h":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "7d":   { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "30d":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "90d":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "180d": { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "1y":   { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 },
        "all":  { "volume_usd": 0.0, "fees_usd": 0.0, "fills": 0 }
      },
      "timeseries_daily": [
        { "day": "2026-05-26", "vol": 0.0, "fees": 0.0, "fills": 0 }
      ]
    }
  }
}
```

Payload size grows linearly with the builder count and the timeseries length. With 104 builders and a 400-day cap on `timeseries_daily` the JSON is ~10 MB uncompressed, ~1.2 MB gzipped (Upstash REST gzips by default).

## Why both `hl-archive` and `hyperliquid-frontends-local` exist

| Aspect | `hyperliquid-frontends-local` | `hl-archive` |
|---|---|---|
| Source | Local hl-node L1 dump (`/mnt/hyperliquid/data/node_fills_by_block/hourly/`) | Public HL CDN (`stats-data.hyperliquid.xyz`) |
| Freshness | Sub-minute (last 24 h sliding) | J-1, daily refresh |
| Coverage | 24 h rolling | Aug 2025 to today (~11 months and growing) |
| Storage | In-memory only | DuckDB on disk |
| Host | OVH SGP (hl-node co-located) | Railway |
| Consumer | Live bench card (`/benchmarks/hyperliquid-frontends`) | Historical leaderboard + windowed views (24 h / 7 d / 30 d / 90 d / 180 d / 1 y / all) |
| Failure mode if down | Live card stale, history still served | History stale, live card unaffected |

The two harnesses are intentionally decoupled: live and historical views have very different freshness, infra, and disk requirements, and pinning them together would force the live card to wait on a 24 h batch or the history to be pinned to OVH disk. Each side serves what it is good at.
