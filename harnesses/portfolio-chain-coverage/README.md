# portfolio-chain-coverage

OpenChainBench harness measuring **Portfolio API Chain Coverage** — for each wallet-portfolio API provider, how many blockchains does the vendor *claim* to support, and on how many does their API *actually return real balances*?

## What it measures

Two honest numbers per provider, once per day:

| Number | Meaning | How |
|---|---|---|
| **listed** | Chains the vendor self-declares via a machine-readable catalog endpoint | One catalog call per provider |
| **verified** | Chains where the vendor's portfolio API returned a real balance for the shared test-address set | 1 EVM sweep call + up to ~63 per-chain probes per provider |

The gap between listed and verified is the story: a chain in a marketing list is not the same as a chain where the balance indexer actually works.

## Providers tracked

| Provider | Auth | listed source | verified probe |
|---|---|---|---|
| CoinStats | `X-API-KEY` header | `GET /wallet/blockchains` (`connectionId` rows) | `GET /wallet/balances?networks=all` (all EVM in one call) + `GET /wallet/balance?connectionId=<chain>` for every entry in the shared non-EVM probe set (`addresses.go`, ~138 chains) |
| Zerion | Basic auth (key as username, empty password) | `GET /v1/chains/` (`data[].id`) | `GET /v1/wallets/<addr>/portfolio?currency=usd` for the shared EVM address + every funded 20-byte 0x probe wallet → merged `positions_distribution_by_chain` (EVM only, 5s spacing, sweep aborts on a second 429) |
| Zapper | `x-zapper-api-key` header | none exists → probe-visible networks, exported with `listed_source="probe"` | `POST /graphql` `portfolioV2 → tokenBalances → byNetwork` (single call covers both numbers) |
| Mobula | `Authorization` header | `GET /api/1/blockchains` | `GET /api/1/wallet/portfolio?wallet=<addr>&fetchAllChains=true` for the EVM address + every deduped address in the shared non-EVM probe set, best-effort (4xx tolerated) |
| Moralis | `X-API-Key` header | none exists → chains its net-worth call accepted, exported with `listed_source="probe"` | `GET /api/v2.2/wallets/<EVM>/net-worth?chains[]=…` (candidate list, see `MORALIS_CHAINS`) + Solana gateway `GET /account/mainnet/<SOL>/portfolio` best-effort (4xx tolerated) |

A provider whose key env var is empty is **skipped gracefully** (logged once) — the harness runs with a partial cohort rather than failing.

## Fairness rules

- **Identical test addresses for every provider.** One shared EVM address (`0xF977814e90dA44bFA03b6295A0616a897441aceC`, Binance 8 hot wallet — covers every EVM chain in one sweep) plus a pinned per-chain set of ~138 public high-balance per-chain addresses (exchange cold wallets, protocol treasuries, Cosmos community-pool module accounts — full list with sourcing rules in `cmd/script/addresses.go`). Every provider that accepts an address type gets the identical address.
- **Verified threshold: balance value > $1** per chain — filters dust/spam-token noise while staying far below the real balances these wallets hold. When a response carries no USD pricing at all, native token amount > 0 counts instead.
- **listed vs verified are never mixed.** `listed` is what the vendor declares; `verified` is what the probe observed. Zapper and Moralis have no standalone catalog endpoint, so their listed counts come from the probe and are labeled `listed_source="probe"` (vs `"declared"` for the others) so dashboards can qualify the comparison.
- **Same retry policy for everyone.** Per-call timeout 20s; one retry after 30s on 5xx/timeout only, never on 4xx.
- **Publish-then-leave.** A failed cycle leaves the provider's previous gauge values in place (Prometheus retention carries them forward) and buckets the failure in the error counter; other providers are unaffected.

## Probe budget

Probes spend paid API credits, so the cadence is deliberately daily:

- CoinStats: ~107 calls (1 catalog + 1 EVM sweep + ~105 per-chain probes)
- Zerion: ~55 calls (1 catalog + ~54 wallet sweeps, 5s spacing)
- Zapper: 1 call
- Mobula: ~117 calls (1 catalog + 1 EVM sweep + ~115 probe wallets best-effort)
- Moralis: ~19-37 calls (1 net-worth per candidate chain + native-balance fallbacks + 1 Solana best-effort)

Total ≈ 300-340 upstream calls/day for the full cohort (~9k/month, far below every vendor's monthly quota). Rate limits bite on bursts, not volume: every multi-chain sweep spaces calls by 1.5s (`sweepSpacing`), so a cycle takes a few minutes and no vendor ever sees more than ~40 requests/minute. `portfolio_probe_calls_total{provider}` counts every attempt (retries included) — watch `increase(...[30d])` against each vendor's quota to catch drift. One full cycle runs at startup, then every `PROBE_INTERVAL_HOURS` (default 24 — **never lower the default**). Providers run sequentially with 5s spacing.

## Metrics

| Name | Type | Labels | Help |
|---|---|---|---|
| `portfolio_chains_listed` | gauge | provider, listed_source | Self-declared chain count. `listed_source` is `declared` (catalog endpoint) or `probe` (Zapper, Moralis: probe-visible networks). |
| `portfolio_chains_verified` | gauge | provider | Distinct chains with a real balance (> $1, or native amount > 0 when USD absent) for the canonical test addresses. |
| `portfolio_probe_latency_ms` | gauge | provider | Aggregate HTTP round-trip across all calls of the last probe cycle. |
| `portfolio_probe_errors_total` | counter | provider, kind | Probe failures bucketed as timeout / auth / rate_limit / server_error / not_found / parse / other. |
| `portfolio_last_probe_timestamp` | gauge | provider | Unix time of the last cycle that published at least one value. Staleness alarm for the daily cadence. |
| `portfolio_probe_calls_total` | counter | provider | Upstream HTTP attempts per provider (retries included). Monthly credit-budget watchdog. |
| `portfolio_chains_probed` | gauge | provider | Chains tested with a known-funded address and answered definitively. `verified/probed` = demonstrable indexer success rate. |

## Env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `COINSTATS_API_KEY` | no* | — | CoinStats key. Empty = provider skipped. |
| `ZERION_API_KEY` | no* | — | Zerion key. Empty = provider skipped. |
| `ZAPPER_API_KEY` | no* | — | Zapper key. Empty = provider skipped. |
| `MOBULA_API_KEY` | no* | — | Mobula key. Empty = provider skipped. |
| `MORALIS_API_KEY` | no* | — | Moralis key. Empty = provider skipped. |
| `PROBE_INTERVAL_HOURS` | no | `24` | Hours between probe cycles. Do not lower without a credit-budget reason. |
| `COINSTATS_BASE_URL` / `ZERION_BASE_URL` / `ZAPPER_BASE_URL` / `MOBULA_BASE_URL` / `MORALIS_BASE_URL` / `MORALIS_SOL_BASE_URL` | no | vendor prod hosts | Override an API host without a rebuild. |
| `MORALIS_CHAINS` | no | EVM mainnets per docs.moralis.com/supported-chains | Comma-separated hex chain ids for the Moralis net-worth candidate list. |
| `LOGS_TOKEN` | no | — | Enables `GET /logs?tail=N` (header `X-Logs-Token`). Unset = endpoint disabled. |

\* at least one key should be set for the harness to publish anything.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /metrics` | Prometheus exposition. Scraped by the OCB Prometheus. |
| `GET /health` | Plain `ok`. Deploy probe. |
| `GET /logs?tail=N` | Ring-buffered stdout, gated by `LOGS_TOKEN`. |
| `GET /` | Banner string. |

## Development

```bash
go vet ./...
go build -o /tmp/pcc ./cmd/script
go test ./...
```

The response parsers are unit-tested against JSON fixtures in `cmd/script/parse_test.go` — vendor payload shape drift shows up as a `kind="parse"` error bucket in production and as a red test locally.
