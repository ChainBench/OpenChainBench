# Harness · token-quote-coverage

> Go harness for bench № 102. Measures the share of newly-launched tokens each DEX aggregator can return a valid swap quote for, sampled from Dexscreener token-boosts across Solana, Base and BNB.

**Bench**: [№ 102 · Token quote coverage](../../benchmarks/token-quote-coverage.yml)

**Providers**: Mobula · Jupiter (Solana) · KyberSwap (EVM) · 1inch (EVM) · OKX DEX (multi-chain) · Odos (EVM)

## How it works

Every 60 minutes:

1. Fetch up to 30 recently-active tokens from Dexscreener `/token-boosts/latest/v1`.
2. Batch-resolve originating DEX via `/latest/dex/tokens/{addresses}` to assign a `venue` label (pump-fun, virtuals, four-meme, etc.).
3. Fire a `1 USDC → token` quote at every provider that supports the token's chain, with a 10 s timeout per probe.
4. Record hit (`outAmount > 0`) or miss into `token_quote_coverage_success_total` / `token_quote_coverage_attempts_total` counters with `{provider, venue, chain}` labels.
5. Expose counters at `:2112/metrics` for Prometheus scrape.

The bench YAML computes `increase(success[24h]) / increase(attempts[24h]) * 100` live at read time.

## Metrics produced

| Metric | Labels | Description |
| --- | --- | --- |
| `token_quote_coverage_success_total` | `provider, venue, chain` | Quote probes that returned outAmount > 0 |
| `token_quote_coverage_attempts_total` | `provider, venue, chain` | All quote probe attempts |

## Run locally

```bash
cp .env.example .env
# Fill in MOBULA_API_KEY and ONEINCH_API_KEY at minimum
go run ./cmd/monitor/
```

Metrics will be at `http://localhost:2112/metrics`. No transactions, no wallets needed.

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `MOBULA_API_KEY` | yes | `Authorization: <key>` header |
| `ONEINCH_API_KEY` | yes | `Authorization: Bearer <key>` header |
| `OKX_DEX_API_KEY` | no | Optional; public rate limits apply without it |
| `MONITOR_REGION` | no | Metric label, default `eu-west` |
| `LOGS_TOKEN` | no | Enables `/logs?tail=N` debug endpoint |

## Docker

```bash
docker build -t token-quote-coverage .
docker run --rm --env-file .env -p 2112:2112 token-quote-coverage
```

## Provider chain scope

| Provider | Solana | Base | BNB |
| --- | --- | --- | --- |
| Mobula | yes | yes | yes |
| Jupiter | yes | no | no |
| KyberSwap | no | yes | yes |
| 1inch | no | yes | yes |
| OKX DEX | yes | yes | yes |
| Odos | no | yes | yes |

Providers are never probed on unsupported chains; those cells show `null` on the bench leaderboard, not zero.
