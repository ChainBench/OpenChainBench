# hl-archive runbook

Operations manual for the `hl-archive` Railway service. Pair this with the [README](./README.md) for the user-facing contract and `DEPLOY.md` (in the same directory once shipped) for the deploy recipe.

## Deploy a new version

See `DEPLOY.md` in this directory. Short version: push to `dev`, let Railway auto-build the `hl-archive` service, watch the deploy log until you see `http server listening addr=0.0.0.0:2114`. Production cuts ship via the standard mobula-api `main` promotion.

## Healthcheck

```bash
curl -s https://hl-archive-production.up.railway.app/health | jq
```

A healthy response is:

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

Interpretation:

| Field | Healthy range | Why it matters |
|---|---|---|
| `status` | `ok` | `degraded` means store query failed or lag > 48 h. |
| `db_size_bytes` | grows ~150 KB/day | A flat number for 48 h means writes are not landing. |
| `builders_count` | matches `data/builders.json` length (104) | Lower = registry not loaded or DB truncated. |
| `days_count` | climbs by one per cron tick | Drop = rebuild in progress or DB rolled back. |
| `last_processed_day` | yesterday UTC | Two days old = the cron tick missed. |
| `lag_hours` | 18 - 30 | > 30 = the `hl_archive_lag_hours` Prom alert should already be paging. |

The HTTP status is always 200; rely on `hl_archive_lag_hours` and `hl_archive_cron_runs_total{result="err"}` for alerting, not on the response code.

## Trigger a manual backfill

A date range that overlaps days already in `processed_days` is skipped per-day; to force a re-parse, delete those rows from DuckDB first (see "Force-replay one day" below). Otherwise the call is idempotent.

```bash
railway run --service hl-archive -- \
  hl-archive backfill --from 2025-08-01 --to 2026-06-28
```

For one missing day:

```bash
railway run --service hl-archive -- \
  hl-archive backfill --from 2026-06-23 --to 2026-06-23
```

After the backfill, push a fresh snapshot. `daily` always targets J-1, so if the missing day is older, the snapshot you get already covers it once it is in the DB. To force a push:

```bash
railway run --service hl-archive -- hl-archive daily
```

### Force-replay one day

`backfill` skips days that already have a `processed_days` entry. To overwrite an existing day:

```bash
railway run --service hl-archive -- \
  hl-archive query --builder 0xb84168cf3be63c6b8dad05ff5d755e97432ff80b --days 1
# inspect what is there, then drop the row via a one-off SQL session:
railway run --service hl-archive -- bash -c \
  "echo \"DELETE FROM processed_days WHERE day='2026-06-23';\" \
   | duckdb /data/history.duckdb"
railway run --service hl-archive -- \
  hl-archive backfill --from 2026-06-23 --to 2026-06-23
```

## Rebuild from scratch

Destructive. Drops the aggregate tables in `/data/history.duckdb` and re-walks the CDN from `HL_ARCHIVE_BACKFILL_FROM` (default `2025-08-01`) to J-1. Expect ~30 min wall-clock at 16 workers and ~50 MB of DuckDB at the end of a full year.

```bash
railway run --service hl-archive -- hl-archive rebuild --confirm
```

If the rebuild is itself failing (CDN throttle, LZ4 corruption), inspect the dead-letter file:

```bash
railway run --service hl-archive -- cat /data/history.duckdb.failures.jsonl | tail
```

Each line is `{ts, builder, day, reason}`. Re-run the failed days individually with `backfill`.

## Alerts and remediation

### `hl_archive_lag_hours > 30`

The configured cron hour (default 02:00 UTC) didn't run or didn't finish.

1. Check `last_processed_day` in `/health`. If it is today minus 2 or older, the cron missed.
2. Look at the service logs in Railway for the most recent `cron next fire` and `cron tick` lines and any error after them.
3. Trigger the missed day manually:

   ```bash
   railway run --service hl-archive -- hl-archive daily
   ```

   (`daily` always targets J-1; if J-2 is also missing, run `backfill --from J-2 --to J-2` first.)

4. If `daily` succeeds, the alert clears within one scrape interval. If it fails, fall through to the next alert.

### `hl_archive_files_processed_total{result="error"}` rising

The CDN is throttling or has changed its CSV/LZ4 format.

1. Tail the logs filtered on the parse layer: look for `cdn 5xx`, `cdn unavailable after retries`, or `csv header missing required columns`.
2. If the error is a 5xx or transient network failure, wait one cron tick: the next `daily` retries idempotently.
3. If the error is `csv header missing required columns`, the HL team changed the CSV schema. Fix the column index in `script/parse.go`, ship, rebuild.
4. Inspect the dead-letter for the affected (builder, day) pairs:

   ```bash
   railway run --service hl-archive -- tail -n 50 /data/history.duckdb.failures.jsonl
   ```

5. Once the fix is in, re-run those days with `backfill --from --to` covering the affected range (delete the offending `processed_days` rows first if they were stored as zero-row days).

### Healthcheck reports `status: degraded`

DuckDB lock, disk full, or `lag_hours > 48`.

1. Check disk on the Railway volume:

   ```bash
   railway run --service hl-archive -- df -h /data
   ```

   If `/data` is > 90 % full, expand the Railway volume.

2. If disk is fine, check for a stale lock file:

   ```bash
   railway run --service hl-archive -- ls -la /data
   ```

   A leftover `history.duckdb.wal` after a crash is normal; DuckDB replays it on next open. A separate `.lock` file from a hung process is not - restart the service to clear it.

3. If the file itself is corrupt (rare), see "Disaster recovery" below.

### `hl_archive_upstash_push_duration_seconds` p95 > 5 s

Either Upstash is slow or the JSON payload has bloated past the REST endpoint's comfort zone.

1. Confirm the size by running `daily` locally with `LOG_LEVEL=debug`; the `upstash push ok bytes=...` log line tells you the marshalled size.
2. If the byte count is unchanged and the Upstash status page is green, the issue is the underlying network. Re-deploy to force a fresh outbound connection pool.
3. If the count has jumped (someone added many builder addresses), audit `data/builders.json` and decide whether to keep them all. The snapshot grows linearly with the registry × timeseries length.
4. As a temporary mitigation, lower the timeseries cap by trimming `tsDays` (currently capped at 400) in `script/server.go` `buildPayload`.

## Disaster recovery

Lost DuckDB file (volume wiped, accidental `rm`, corrupted beyond repair):

```bash
railway run --service hl-archive -- hl-archive rebuild --confirm
```

The rebuild fully recovers in ~30 min from the public CDN. No backup is needed because the source data is public and immutable. The `data/builders.json` registry IS the only piece of state that lives in this repo; keep it under version control.

## Schema migration

The Upstash payload shape is versioned in the key (`ocb:hl-archive:v1`). To change the snapshot JSON shape:

1. Bump the key in `HL_ARCHIVE_UPSTASH_KEY` env to `ocb:hl-archive:v2` on the Railway service, but keep writing the old key too. Add a temporary second `PushUpstash` call inside `cmdDaily` that points at the legacy key.
2. Ship the OCB Next.js reader change behind a flag that reads `v2` with `v1` as fallback.
3. After 48 h of parallel writes, flip the Next.js to read `v2` only.
4. After another 48 h, remove the `v1` write from `hl-archive` and delete the key.

For DuckDB schema changes (new column, type widening): add a `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` in `script/store.go` `schemaSQL`, ship, restart. Pure additive columns can ship without any orchestration; type changes or column renames need the same parallel-write dance as the KV key.

## Capacity planning

| Resource | Per year of coverage | Notes |
|---|---|---|
| DuckDB on disk | ~50 MB | Aggregated rows only, no raw fills. At 104 builders and 200 active coins the steady-state row count is ~7.5 M / year. |
| Upstash payload | ~10 MB JSON, ~1.2 MB gzipped | Linear in builders × timeseries length (cap 400 days). Each new builder adds ~10 KB. |
| Railway memory | < 256 MB resident | Streaming parser, only the per-day aggregator is held in RAM. |
| Railway CPU | spikes during cron tick, idle otherwise | 16 workers saturate ~2 vCPU for the ~3 min the daily run takes. |
| CDN bandwidth | < 100 MB / day at steady state | One LZ4 per (builder, day); most under 1 MB. Rebuild pulls ~10 GB. |

Volume sizing: provision 2 GB on the Railway volume for `/data`. That gives years of headroom plus room for the `.wal` and dead-letter files.
