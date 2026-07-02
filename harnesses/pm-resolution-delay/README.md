# pm-resolution-delay

OpenChainBench harness measuring how long Polymarket markets take to resolve,
the dispute rate, and the delay disputes add. Replaces the unsourced
"93% of Polymarket markets resolve within 2h" stat with a measured number.

## What it measures

For every Polymarket question on Polygon:

```
resolution_delay = QuestionResolved block timestamp
                 - first OO ProposePrice block timestamp (same questionID)
```

That is the time from "the outcome was submitted on-chain" to "holders can
redeem", which includes the UMA challenge window (~2h liveness) plus any
dispute rounds. A question is `disputed=true` if an OO `DisputePrice` or an
adapter `QuestionReset` was seen before resolution; disputed questions stay
anchored at their FIRST proposal so reset rounds lengthen the measured delay.

### Why the anchor is the proposal, not Gamma's close fields

Both obvious Gamma anchors are unusable, verified live on 2026-06-12:

- `closedTime` is written AT resolution. For a sample market it matched the
  `QuestionResolved` block timestamp to the second (`2026-06-12 17:21:34`).
  Anchoring on it would measure ~0 for every market.
- `endDate` is a scheduled buffer: 59 of 100 recently resolved markets
  resolved BEFORE their `endDate` (sports micro-markets carry a date days
  after the game). Anchoring on it would produce negative delays.

The first `ProposePrice` is the earliest on-chain moment the outcome is
known, which for sports lands minutes after the game ends. This also means
the popular "93% within 2h" claim cannot even be computed from Gamma fields,
which is part of the finding.

## On-chain sources (fact-checked live, 2026-06-12)

| Contract | Address | Events used |
|---|---|---|
| UmaCtfAdapter (binary) | `0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7` | QuestionInitialized, QuestionResolved, QuestionReset |
| UmaCtfAdapter (neg-risk) | `0x69c47De9D4D3Dad79590d61b9e05918E03775f24` | same |
| Optimistic Oracle | `0x2c0367a9DB231dDEbD88a94b4f6461a6E47C58b1` | ProposePrice, DisputePrice (requester filtered to the adapters) |

These are the post-migration deployments: Gamma's `resolvedBy` points at
them and they emit ~5.5k `QuestionResolved`/day, while the historical
V1/V2/V3 adapters are silent. The oracle address was located by tracing a
live `initialize()` transaction. New deployments are config
(`ADAPTER_ADDRESSES`, `OO_ADDRESSES`), not code.

Join key: `questionID = keccak256(ancillaryData)` — verified live by hashing
a `ProposePrice` ancillary payload and matching the resulting questionID to
a `QuestionInitialized` log on the adapter.

## Categories

`sports | politics | crypto | other`. Primary source: tag slugs on Gamma
`/events` (tags only exist there; `/markets` returns `category: null`).
Fallback when a market resolves before its event was crawled: keyword match
on the UMA ancillary title (`q: title: ...`). Precedence sports > politics >
crypto.

Known limitation: for neg-risk markets Gamma's `questionID` is the
NegRiskAdapter market id, NOT `keccak256(ancillaryData)` (verified live), so
the tag join misses them and they always classify via ancillary keywords.
The delay measurement itself is unaffected: the adapter's QuestionResolved
questionID always equals the keccak of the OO ancillary, for both adapters.

## Prometheus metrics (`:2112/metrics`, namespace `pmres_`)

| Metric | Labels | Meaning |
|---|---|---|
| `pmres_resolution_delay_seconds` | category, disputed | Histogram, buckets 5min..14d (2h is a bucket edge) |
| `pmres_resolutions_total` | category, disputed | Resolutions joined to a proposal |
| `pmres_disputes_total` | category | Questions disputed before resolution (once per question) |
| `pmres_pending_markets` | category | Open markets past their scheduled `endDate`, unresolved (30d lookback) |
| `pmres_oldest_pending_age_seconds` | | now − oldest pending `endDate` |
| `pmres_listener_health` | | 1 if logs polled OK in the last 5 min |
| `pmres_rpc_errors_total` | kind | JSON-RPC failures (http, rpc_error, decode, timeout) |

`pmres_pending_markets` deliberately uses `endDate` (the only pre-resolution
anchor that exists); it counts markets whose scheduled end passed without
resolution, i.e. the genuinely late ones.

## Restart semantics (no DB)

On startup the harness rebuilds state from scratch:

1. Deep-crawls recently closed Gamma events for the questionID→category map.
2. Binary-searches the Polygon block at `now − BACKFILL_HOURS` (default 7
   days) and replays adapter + oracle logs in `CHUNK_BLOCKS` (2000) chunks,
   rotating across `RPC_URLS` with exponential backoff on 429/limits.
3. Then polls incrementally every `POLL_SECONDS` (45s). No websockets:
   public Polygon WS is flaky.

Consequences, by design:

- Counters and histograms re-count the whole backfill window after every
  restart. Use `rate()` / `increase()` over windows, and treat the restart
  burst as a counter artifact (OCB's Prom queries already do).
- Resolutions whose proposal predates the backfill window are logged and
  skipped (no fake delays). With proposal→resolution typically ~2h, a 7-day
  window loses only long-disputed edge cases.
- Block timestamps inside a backfill chunk are linearly interpolated between
  the chunk-boundary blocks' exact timestamps (2 RPC calls per chunk).
  Polygon's steady ~2.1s cadence keeps the error far below the smallest
  300s bucket.
- Malformed payloads (Gamma or RPC) are logged and skipped, never fatal.

All HTTP carries `User-Agent: OpenChainBench/1.0
(+https://openchainbench.com/methodology; contact@mobula.io)`.

## Env vars

See `.env.example`. None are required; defaults are the verified live values.
`LOGS_TOKEN` enables the `GET :2112/logs?tail=N` ring-buffer endpoint
(header `X-Logs-Token`).

## Deploy

Railway, Dockerfile build, single service, single region (resolution delay
is not regional). Metrics listener hardcoded to `:2112` per OCB convention
($PORT is ignored).
