# pm-rate-limits harness

Probes the public developer APIs of 5 prediction-market venues (Polymarket,
Kalshi, Limitless, Manifold, Myriad) for latency and throttle behaviour, and
runs a daily rate-limit ramp ("crash test"). Feeds the OpenChainBench
`pm-rate-limits` benchmark. Prometheus metrics on `:2112` (OCB convention,
Railway `$PORT` ignored).

## What it measures

- **Warm latency** per (venue x class): `book`, `price`, `list`. Keep-alive
  pool, full round-trip + TTFB, per-sample CDN cache label
  (cf-cache-status / x-cache / age).
- **Cold connect**: 1/min per venue with keep-alives disabled, TCP+TLS
  handshake recorded separately.
- **Book staleness**: server-reported data age. Only Polymarket
  (book `timestamp`) and Manifold (`lastUpdatedTime`) expose one.
- **Public WebSocket** (Polymarket only): connect-to-snapshot, update
  inter-arrival, disconnects. Kalshi WS requires auth, the others have no
  comparable public WS.
- **Daily ramp**: 60s tiers at N requests per 10s against the book endpoint,
  one run per venue per day, regions on disjoint UTC hours. Headline metric is
  `pmapi_ramp_added_latency_seconds` = p50(tier) - p50(warm baseline, last
  hour). Venues that queue under load show added latency without ever
  returning 429.

## Fairness rules baked in

- Pinned market per venue: most liquid, near-the-money, expiry >24h, re-pinned
  daily at 00:00 UTC and immediately on `probe_invalid`.
- A stale pin (e.g. Limitless serves a CDN-cached 400 for 4h once a market
  expires) is classified `probe_invalid`, never as a venue error.
- Latency histograms record successful requests only; failures land in
  `pmapi_requests_total{outcome}`.
- Ramp clamps: Manifold 15/30/60 per 10s (500 req/min/IP documented), Limitless
  10/20/40 (limits undocumented), Kalshi stops at the first 429 (documented
  token bucket), Myriad excluded (keyless 30 req/10s budget). Global abort when
  throttled+5xx exceed 1% of any 10s window.
- Identifying User-Agent on every request:
  `OpenChainBench/1.0 (+https://openchainbench.com/methodology; contact@mobula.io)`.
- Only latency measurements are published, never venue order book or price
  data (Kalshi data redistribution terms, applied to all venues).

## Endpoints probed

| Venue | book | price | list |
|---|---|---|---|
| Polymarket | clob `/book?token_id=` | clob `/midpoint?token_id=` | gamma `/markets?order=volume24hr` |
| Kalshi | `/markets/{ticker}/orderbook` | `/markets/{ticker}` | `/markets?status=open` (CloudFront, max-age=15) |
| Limitless | `/markets/{slug}/orderbook` | `/markets/{slug}` | `/markets/active` |
| Manifold | `/v0/bets?contractId=` | `/v0/market/{id}` | `/v0/markets` (max-age=5 + swr=10) |
| Myriad | none (AMM, no feed) | `/markets/{slug}` | `/markets?state=open` |

## Run

```bash
cp .env.example .env
go run ./cmd/script
curl -s localhost:2112/metrics | grep pmapi_
```

Deploy: one Railway service per region (us-east / eu-west / sgp) with `REGION`
set; scraped by the shared OCB Prometheus at `<service>.railway.internal:2112`.

Debug: `GET :2112/logs?tail=500` with `X-Logs-Token: $LOGS_TOKEN`.
