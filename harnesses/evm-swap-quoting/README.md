# evm-swap-quoting harness

OpenChainBench bench #033 — EVM swap quote latency across major aggregators.

Measures wall-clock p50/p90/p99 latency of `GET <provider>/quote` on a
rotating 5-pair basket spanning Ethereum, Base, Arbitrum and BSC. Runs in
3 regions (us-east, eu-west, sgp) so the leaderboard can be filtered to a
single edge if a user only cares about one geography.

## Providers shipped in V1

| Provider | Auth | Speed observed | Notes |
|---|---|---|---|
| Mobula | API key (Mobula sponsor) | ~120ms | `Authorization: <key>` (no Bearer). Human-readable amount. |
| KyberSwap | none | 170-460ms | `x-client-id: openchainbench` optional. Wei amount. Chain slug in URL. |
| Bebop | none | ~380ms | `source: openchainbench` header. EIP-55 checksum addresses. Wrapped-native sell-side. |
| LI.FI | none | ~840ms | Same-chain via `fromChain == toChain`. |
| OpenOcean v4 | none | 0.8-1.3s | Numeric chainId in URL. Human-readable amount. |

## Providers that require additional keys (off by default)

- **1inch v6** — free signup at `portal.1inch.dev`. Set `ONEINCH_API_KEY`.
- **0x v2** — free signup at `dashboard.0x.org`. Set `ZEROX_API_KEY`.
- **Odos v2** — anonymous works but rate-limits to ~3 calls per IP bucket. Free signup at `app.odos.xyz/api` widens the bucket. Set `ODOS_API_KEY`.

## Run locally

```bash
cp .env.example .env
# fill MOBULA_API_KEY
go build -o monitor ./cmd/monitor
./monitor
```

## Endpoints

- `:2112/metrics` — Prometheus scrape (hardcoded — Railway $PORT ignored)
- `:2112/logs?tail=N` — last N log lines (token-gated by LOGS_TOKEN if set)
- `:2112/healthz` — liveness probe

## Metrics

- `evm_swap_quote_latency_ms{provider, chain, region}` — histogram (buckets 10ms to 5s)
- `evm_swap_quote_success{provider, chain, region}` — gauge (1 = last probe ok)
- `evm_swap_quote_throttled_total{provider, chain, region}` — counter (429s)
- `evm_swap_quote_auth_error_total{provider, chain, region}` — counter (401/403)
- `evm_swap_quote_no_route_total{provider, chain, region}` — counter (0-amount responses)
- `evm_swap_quote_other_error_total{provider, chain, region, error_type}` — counter (network/timeout/parse/5xx)

## Basket (V1, hardcoded)

| Chain | TokenIn | TokenOut | Amount |
|---|---|---|---|
| Ethereum | ETH | USDT | 1 |
| Ethereum | USDC | USDT | 1000 |
| Base | ETH | USDC | 0.5 |
| Arbitrum | USDC | ETH | 100 |
| BSC | BNB | USDT | 1 |

Cadence: 60s tick, one pair per tick (round-robin). Every (provider, chain) is sampled every 5 minutes = 288 samples / 24h.
