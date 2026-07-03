# hl-archive integration tests

Smoke test for the `hl-archive` binary. The CDN parse path is covered by the in-process Go integration test (`script/integration_test.go`); this shell driver covers the binary surface (`/health`, `/v1/aggregates` auth, `/metrics`) by booting the real binary against a scratch DuckDB.

## What `smoke.sh` does

1. Runs `go test ./script/...`. The `TestProcessDay_EndToEnd` case in `integration_test.go` stands up an in-process `httptest` CDN, serves a fixture LZ4 payload, and exercises parse -> aggregate -> DuckDB commit -> `Stats()`.
2. Builds the binary (`go build -o /tmp/hl-archive ./cmd/hl-archive`).
3. Boots `hl-archive serve` against a fresh empty DuckDB on a tempdir, with a random API key.
4. Asserts:
   - `GET /health` returns 200 and a payload with `status`, `db_size_bytes`, `builders_count`, `days_count`, `version`.
   - `GET /v1/aggregates?window=30d` returns 401 without `X-API-Key`.
   - Same call with `X-API-Key` returns 200 and an `{updated_at, builders}` payload (`builders` is an empty object on a fresh DB).
   - `GET /metrics` exposes the `hl_archive_*` family.
5. Tears the server down.

The shell smoke does NOT exercise the CDN parse layer. The CDN URL is a Go const (`script/parse.go` -> `cdnURLTemplate`), so a shell-level mock CDN cannot reach the parser without code changes. Once the binary grows an `HL_ARCHIVE_CDN_BASE` env hook, the fixtures under `fixtures/csv/` can drive a full backfill from shell.

## Layout

```text
tests/integration/
  README.md
  smoke.sh
  fixtures/
    csv/                                # CSV templates, mirror of the HL CDN tree
      0xb84168cf3be63c6b8dad05ff5d755e97432ff80b/
        20260620.csv
        20260621.csv
        20260622.csv
      0x1cc34f6af34653c515b47a83e1de70ba9b0cda1f/
        20260620.csv
        20260621.csv
        20260622.csv
    expected/
      aggregates_30d.json               # what /v1/aggregates should return once the fixtures are loaded
```

The fixture CSVs use the same `time,user,coin,px,sz,builder_fee` header as the real CDN files, and the same lowercased-address directory layout. Each file is six rows across three assets (BTC, ETH, SOL or ARB) with deterministic users so the aggregates are easy to recompute by hand.

## Requirements

- `go` >= 1.24
- `jq`
- `curl`
- A free TCP port at `:2114`

## Run

```bash
cd miniapps/hl-archive
bash tests/integration/smoke.sh
```

Exit code 0 means the smoke passed. Non-zero prints the failed assertion.

## CI

The smoke is meant to run in PR CI on every change under `miniapps/hl-archive/`. It is intentionally self-contained: no Docker, no Upstash, no CDN access required.

## Adding a fixture day

1. Drop a new file `fixtures/csv/<builder>/<YYYYMMDD>.csv` with the same header as the others.
2. Recompute the expected aggregates and update `fixtures/expected/aggregates_30d.json` by hand (the file is small).
3. Once the binary grows `HL_ARCHIVE_CDN_BASE`, extend `smoke.sh` to spin up a `python3 -m http.server` on the fixtures dir, run `hl-archive backfill --from --to`, and diff the live `/v1/aggregates` response against the expected fixture.
