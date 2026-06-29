# pm-freshness-bench

Bench №032 — prediction market data freshness across providers.

Subscribes to the same basket of high-volume Polymarket markets on three
data providers simultaneously, cross-correlates each trade event by
`(conditionId, outcomeId, price, size, time-window)` and measures how
many milliseconds each provider lags the canonical Polymarket CLOB WS
gateway.

## Providers (v2)

The bench now compares per-venue. Polymarket events flow through 3 providers;
Kalshi events flow through 2 (no Mobula Kalshi coverage).

| Venue | Provider | Endpoint | Auth | Notes |
|---|---|---|---|---|
| Polymarket | Polymarket CLOB | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | none | Canonical T0 for Polymarket |
| Polymarket | Codex / defined.fi | `wss://graph.codex.io/graphql` | scraped JWT + Webshare proxy | Firehose, branch on marketId suffix |
| Polymarket | Mobula PM | `wss://pm-api-prod-eu.mobula.io` | API key | Browser UA required |
| Kalshi | Kalshi public REST | `https://api.elections.kalshi.com/v1/social/trades` | none | Canonical T0 via `create_date` (venue clock, µs precision) |
| Kalshi | Codex / defined.fi | (same firehose) | (same auth) | Filtered to `:Kalshi` marketIds |

## Run locally

```bash
cp .env.example .env
# fill in keys
go build ./cmd/script
./script
```

## Endpoints

- `:2112/metrics` — Prometheus scrape (hardcoded — Railway $PORT ignored)
- `:2112/logs?tail=N` — last N log lines (token-gated by `LOGS_TOKEN` when set)

## Metrics

All metrics now carry a `venue` label (`polymarket` | `kalshi`). The T0
reference clock per venue is the direct venue feed (`polymarket` for
Polymarket events, `kalshi` for Kalshi events).

- `pm_freshness_delta_ms_bucket{provider, venue, kind}` histogram — per-event
  delta vs that venue's T0, kind ∈ {trade, price}
- `pm_events_total{provider, venue, kind}` counter — raw events received
- `pm_matched_total{provider, venue, kind}` counter — events successfully matched to T0
- `pm_health{provider, venue}` gauge — 1 if (provider, venue) published at least
  one event in the last 60 s, else 0
- `pm_fetch_errors_total{provider, venue, error_type}` counter
- `pm_basket_size{venue}` gauge

## Kalshi support

Kalshi runs as a second venue alongside Polymarket. Codex's
prediction-trades firehose already carries Kalshi trades; we just stopped
filtering them out. The Kalshi T0 (canonical publish time) comes from the
public `/v1/social/trades` REST endpoint — the same one that powers the
trade ticker on kalshi.com homepage. No account, no KYC, no key.

The freshness measurement uses the `create_date` field embedded in the
Kalshi response, which is the venue's own publish timestamp at microsecond
precision. The poll cadence (default 5s, tunable via
`KALSHI_POLL_INTERVAL_SEC`) only governs when correlation happens, not
the measurement itself: a Codex relay event that lands at T+100ms is
still credited with a 100ms delta even if our poller surfaces the matching
Kalshi trade up to 5 seconds later.

CloudFront fronts the endpoint with `max-age=10s`; polling faster than
~5s just hits cache. Tested live from Paris with 200ms RTT, no geo
block, no auth header required.

## Methodology

Every 5 minutes the harness polls `gamma-api.polymarket.com` for the top-20
active markets by 24h volume, then opens / updates subscriptions on all
three providers simultaneously. Trades are indexed in memory for 60 s
after first arrival; deltas are computed against the earliest receive
time for that `(conditionId, outcomeId, price, size)` signature, which
is always the Polymarket T0 if Polymarket emitted the trade at all.

Polymarket trades that no other provider relays in the 60 s window are
counted in `pm_events_total{provider="polymarket"}` but not in any
matched counter.
