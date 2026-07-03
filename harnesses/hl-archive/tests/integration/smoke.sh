#!/usr/bin/env bash
# smoke.sh - end-to-end smoke test for hl-archive
#
# Two layers:
#
#   1. go test ./script/... covers the parse -> store -> stats path
#      via the in-process httptest CDN in integration_test.go. That
#      proves LZ4 decode, CSV streaming, DuckDB upsert and the daily
#      Stats() snapshot are all wired together.
#
#   2. This shell driver covers the binary surface: it builds
#      hl-archive, boots `serve` against a scratch DuckDB, and asserts
#         a) /health returns 200 with the documented JSON shape
#         b) /v1/aggregates returns 401 without X-API-Key
#         c) /v1/aggregates returns 200 + UpstashPayload shape with it
#         d) /metrics exposes the hl_archive_* family
#
# Layer 2 does NOT hit the CDN: the binary cannot currently be pointed
# at a mock CDN from shell (the CDN URL is a Go const). Backfill
# coverage lives in layer 1.
#
# Fixture CSV templates live under fixtures/csv/<builder>/<YYYYMMDD>.csv
# so the same data can be reused once the binary grows an
# HL_ARCHIVE_CDN_BASE env hook (see README "Adding a fixture day").
#
# Run from the repo: bash tests/integration/smoke.sh
#
# Exit codes:
#   0  smoke passed
#   1  smoke failed (last assertion printed)
#   2  prerequisite missing

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d -t hl-archive-smoke.XXXXXX)"
BIN="$WORK/hl-archive"
DB="$WORK/history.duckdb"
API_PORT=2114
API_KEY="smoke-key-$$"

cleanup() {
  local code=$?
  set +e
  [[ -n "${SERVE_PID:-}" ]] && kill "$SERVE_PID" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 2; }
}

require go
require jq
require curl

echo "[1/5] go test ./script/... (parse + store + stats)"
(cd "$ROOT" && go test ./script/...)

echo "[2/5] building hl-archive..."
(cd "$ROOT" && go build -o "$BIN" ./cmd/hl-archive)

# Make sure the listener port is free.
if lsof -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port :$API_PORT already in use, aborting" >&2
  exit 2
fi

export HL_ARCHIVE_DB_PATH="$DB"
export HL_ARCHIVE_BUILDERS_FILE="$ROOT/data/builders.json"
export HL_ARCHIVE_HTTP_ADDR="127.0.0.1:$API_PORT"
export HL_ARCHIVE_API_KEY="$API_KEY"
export LOG_LEVEL=warn
# Skip Upstash push: leaving the URL/TOKEN unset turns the call into a
# warn-and-return inside script/upstash.go.
unset UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

echo "[3/5] booting serve on :$API_PORT (empty DB) ..."
"$BIN" serve >"$WORK/serve.log" 2>&1 &
SERVE_PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null && break
  sleep 0.3
done
if ! curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null; then
  echo "serve did not come up on :$API_PORT, log tail:" >&2
  tail -n 50 "$WORK/serve.log" >&2
  exit 1
fi

echo "[4/5] asserting API contract..."

# (a) /health shape
HEALTH=$(curl -sf "http://127.0.0.1:$API_PORT/health")
echo "$HEALTH" | jq -e '
  .status and
  (.db_size_bytes  | type == "number") and
  (.builders_count | type == "number") and
  (.days_count     | type == "number") and
  (.version        | type == "string")
' >/dev/null || { echo "/health shape mismatch: $HEALTH"; exit 1; }
echo "  /health OK: $(echo "$HEALTH" | jq -c '{status, days_count, builders_count}')"

# (b) /v1/aggregates without key -> 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/v1/aggregates?window=30d")
[[ "$CODE" == "401" ]] || { echo "expected 401 without key, got $CODE"; exit 1; }
echo "  /v1/aggregates 401 without X-API-Key OK"

# (c) /v1/aggregates with key -> 200 + payload shape
AGG=$(curl -sf -H "X-API-Key: $API_KEY" "http://127.0.0.1:$API_PORT/v1/aggregates?window=30d")
echo "$AGG" | jq -e '
  (.updated_at | type == "string") and
  (.builders   | type == "object")
' >/dev/null || { echo "/v1/aggregates shape mismatch: $AGG"; exit 1; }
echo "  /v1/aggregates 200 with X-API-Key OK"

# (d) /metrics exposes the hl_archive_* family
METRICS=$(curl -sf "http://127.0.0.1:$API_PORT/metrics")
for m in hl_archive_db_size_bytes hl_archive_builders_count hl_archive_days_count \
         hl_archive_lag_hours hl_archive_http_requests_total; do
  echo "$METRICS" | grep -qE "^# HELP $m " \
    || { echo "/metrics missing $m"; exit 1; }
done
echo "  /metrics exposes hl_archive_* family OK"

echo "[5/5] smoke OK"
