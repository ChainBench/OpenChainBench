# hl-fills-reduce

Turns the Hyperliquid node's hourly fill stream into per-builder daily
totals, and serves them to `harnesses/hyperliquid-frontends`.

Runs on the Singapore node box (15.235.224.14), not on the OCB VPS: it reads
four gigabytes a day off that machine's local disk.

## Why this exists

The public per-builder export at `stats-data.hyperliquid.xyz` cuts most days
off at roughly 12:10 UTC. Measured on fomo for 2026-10-06:

| | public export | node's own stream |
|---|---|---|
| notional | $53.1M | $192.5M |
| builder fees | $25,288 | $93,131 |
| hours covered | 00:00-12:09 | 00:00-23:59 |

CoinMarketMan, reading a complete feed, published $93.1K of revenue for FOMO
that day. The node agrees with them to within 4%. The export does not, and no
arithmetic on a half day recovers the other half.

The node has the whole day because it is the one applying the blocks.
`hl-visor run-non-validator --write-fills` writes every fill under
`<data>/node_fills_by_block/hourly/<YYYYMMDD>/<hour>`, one JSON object per
block, and each fill carries `builder` and `builderFee` alongside the trader,
coin, price, size, `crossed` and `closedPnl`. Everything the site reports is
in there; it is just four gigabytes a day, so this reduces it to about 1.6 MB.

## What it is not

A second opinion. Where this has a whole day, the consumer uses it *instead
of* the export for that day. The two are never averaged, and a day this only
half covers is declined outright rather than served as a smaller number: a
fraction of a day that looks like a whole one is the exact bug the project
exists to fix.

## Run

```sh
go test ./...
go run ./cmd/script -once -backfill 2     # reduce the last two finished days
go run ./cmd/script                       # daemon, serves on 127.0.0.1:2115
```

| flag / env | default | meaning |
|---|---|---|
| `-addr` / `HL_REDUCE_ADDR` | `127.0.0.1:2115` | listen address |
| `-fills` / `HL_REDUCE_FILLS` | `/mnt/hyperliquid/data/node_fills_by_block/hourly` | node hourly fills |
| `-out` / `HL_REDUCE_OUT` | `/mnt/hyperliquid/ocb-fills-daily` | where reduced days land |
| `-mount` / `HL_REDUCE_MOUNT` | `/mnt/hyperliquid` | filesystem reported in the health metrics |
| `-every` | `30m` | sweep period |
| `-backfill` | `45` | how many days back a sweep considers |
| `-once` | off | reduce what is pending and exit |

About 26 seconds and 1.6 MB per day. A 45-day backfill is roughly 20 minutes.

## Endpoints

| path | returns |
|---|---|
| `/healthz` | `ok`, unauthenticated |
| `/days` | `[{day, hours, complete}]` for everything reduced |
| `/daily/<YYYYMMDD>` | the reduced day, gzipped as stored |
| `/metrics` | reducer health **and the box's** |

Caddy on the box fronts this as `:8090` with basic auth on everything but
`/healthz`, the same model as `:8088` and `:8089`. ufw opens 8090 to the OCB
VPS only.

## The health half is not incidental

On 2026-10-07 this box ran 15 hours with its cleanup job failing every 15
minutes and its disk climbing from 80% to 86%, about a day and a half from
full, and nothing noticed, because no Prometheus scraped it. A full disk stops
the node, and the node is now the only source of whole Hyperliquid days. So
the data and the health of the machine that produces it travel together.

| metric | meaning |
|---|---|
| `hl_reduce_days_total{complete}` | reduced days held, whole vs partial |
| `hl_reduce_newest_day_age_seconds` | staleness of the newest reduced day |
| `hl_reduce_node_last_hour_age_seconds` | **the node's real liveness**: systemd can call it active while it has stopped writing fills |
| `hl_reduce_disk_used_pct`, `hl_reduce_disk_free_bytes` | the filesystem holding the node data |

Alerts live in `deploy/ocb_hl_node_box.yml`, installed into
`/opt/ocb/prom-rules/` on the OCB VPS.

## Three things worth knowing before changing this

**A day is reduced only once it can no longer change.** The sweep skips today,
and skips yesterday until 90 minutes past midnight UTC. Reducing a day the
node is still writing produces a figure that is wrong by however much had not
been flushed, and it would then be cached as final.

**The schema number is load-bearing.** A day written under an older shape
decodes into zeros field by field, silently, so `reduceSchema` is checked on
both ends: the reducer re-reduces a day whose stored schema does not match,
and the consumer declines one it does not recognise.

**Hours are bucketed by write time, not block time.** The first block in hour
0 of a day can carry a `block_time` a fraction of a second inside the previous
day. Each day therefore gives up its last sliver and gains the previous day's,
which nets out and is immaterial at daily resolution, but it is why
`first_fill` on a day sometimes reads `23:59:59` of the day before.

## Retention

`hl-cleanup.sh` on the box keeps `node_fills_by_block/hourly` to 40 days
(`FILLS_RETENTION_DAYS`), which leaves the site's 30-day window plus a margin
for a reducer outage. **Lower it and the window starts falling back to the
truncated export.** Reduced days are about 1.6 MB each and are not pruned by
that script; 45 of them is under 70 MB.
