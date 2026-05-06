# Harness · bridge-monitor

> Real-world benchmark of cross-chain bridges. Produces every metric consumed by both [`benchmarks/bridge-quote-latency.yml`](../../benchmarks/bridge-quote-latency.yml) and [`benchmarks/bridge-fee.yml`](../../benchmarks/bridge-fee.yml). quote latency, cost percent, fees, success rate, end-to-end execution latency.

**Benches**:

- [№ 002 · Bridge. Quote Latency](../../benchmarks/bridge-quote-latency.yml)
- [№ 003 · Bridge. Cost Percent](../../benchmarks/bridge-fee.yml)

**Tracked bridges**: Mobula · Relay · Li.Fi (executed) · Debridge (quote-only. flat fees too high for small tickets)

## How it works

Two loops run simultaneously inside one Go binary:

1. **Quote loop** (free, every 5 minutes). fetches a quote from every bridge for every route × every notional ($5 / $50 / $300). Records quote latency, fees, slippage, estimated time. All four bridges benchmarked here.
2. **Execution loop** (paid, fixed UTC times). actually broadcasts real transactions through Mobula + Relay + Li.Fi. Measures quote → broadcast → settlement end-to-end latency and revert rates. Debridge is excluded from execution.

Plus daily P&L cron, wallet balance metrics, pre-flight tier simulation, and per-tier Slack notifications.

## Where the data goes

This harness is a **data producer only**. it exposes `/metrics` on port `9090` (overridable via `METRICS_PORT`). The shared OpenChainBench Prometheus (see [`/infrastructure/prometheus`](../../infrastructure/prometheus)) scrapes that endpoint:

```
bridge-monitor.railway.internal:9090 ──► prometheus.railway.internal ──► public site
```

## Test routes

### USDC triangle

```
         Solana USDC
         ↗         ↘
        R3          R1
       ↗             ↘
Arbitrum USDT ←──R2─── Base USDC
```

Capital circulates through the triangle. only bridge fees + gas are consumed. Each tier executes one bridge at a time round-trip, then the next bridge starts a fresh triangle with the replenished wallet (peak capital = 1× tier per leg, not 3×).

| Route | From | To | Schedule |
| --- | --- | --- | --- |
| R1 | USDC (Solana) | USDC (Base) | Tiers $5/$50/$300 |
| R2 | USDC (Base) | USDT (Arbitrum) | Tiers $5/$50/$300 |
| R3 | USDT (Arbitrum) | USDC (Solana) | Tiers $5/$50/$300 |
| R4 | TRUMP (Solana) | BRETT (Base) | Weekly $5 only (one-way) |
| R5 | USDC (Arbitrum) | USDC (HyperCore) | Quote-only $5/$50/$300 |

## Metrics produced

### Bridge performance

| Metric | Description |
| --- | --- |
| `bridge_quote_latency_ms` | Time to receive quote |
| `bridge_execution_latency_ms` | Broadcast → funds received |
| `bridge_e2e_latency_ms` | Quote start → funds received |
| `bridge_fees_usd` / `bridge_fees_percent` | Bridge fees only |
| `bridge_cost_usd` / `bridge_cost_percent` | Total cost = fees + slippage + destination gas |
| `bridge_slippage_usd` / `bridge_gas_usd` / `bridge_fix_fee_usd` | Cost breakdown |
| `bridge_estimated_time_ms` | Bridge's own promise from the quote |
| `bridge_output_usd` | USD received on destination |
| `bridge_quote_success` | 1 on success, 0 on error |
| `bridge_success_total` / `bridge_reverts_total` / `bridge_errors_total` | Outcome counters |
| `bridge_consecutive_failures` | Streak length (resets on success) |

### Wallet state

| Metric | Description |
| --- | --- |
| `wallet_balance_usd{chain,token}` | Current USD per leg, refreshed every 5 min |
| `wallet_balance_last_update_timestamp_seconds` | Last refresh timestamp |

The site reads these via the YAML specs. `bridge-quote-latency.yml` reads `bridge_quote_latency_ms_*`, `bridge-fee.yml` reads `bridge_cost_percent`.

## Run locally

```bash
cp .env.example .env
# Fill in API keys, wallet keys (or leave dry-run defaults)
go run ./cmd/monitor/
```

`/metrics` will be exposed on `http://localhost:9090/metrics`.

If `EXECUTION_MODE=dry-run` (default) the monitor only fetches quotes. no transactions, no fees, no wallets needed. Quote-loop metrics still flow normally.

Or via Docker:

```bash
docker build -t bridge-monitor .
docker run --rm --env-file .env -p 9090:9090 bridge-monitor
```

## Execution modes

| Mode | What it does |
| --- | --- |
| `dry-run` | Quotes only. Default. No TX, no fees. |
| `single-test` | One real TX per route at `TEST_AMOUNT_USD` (default $1) then exits. |
| `production` | Full loop + scheduler. Real TX at 10:00 UTC. |

```bash
go run ./cmd/monitor/                                  # dry-run
EXECUTION_MODE=single-test TEST_AMOUNT_USD=0.50 go run ./cmd/monitor/
EXECUTION_MODE=production go run ./cmd/monitor/
```

## Run on Railway

This service is deployed from the OpenChainBench repo, root directory `harnesses/bridge-monitor/`. Set the env vars listed below; the shared Prometheus will pick it up via DNS automatically.

## Project layout

```
cmd/monitor/                       Main binary. quote loop, execution, scheduler
  ├── main.go
  ├── config.go                    Env loading
  ├── metrics.go                   Prometheus metric definitions + HTTP /metrics handler
  ├── scheduler.go                 Fixed UTC time scheduling
  ├── executor.go                  Per-route balance check, exec orchestration
  ├── cycle_sim.go                 Pre-flight viability simulation
  ├── tx_executor.go               TX signing + broadcast (overridable RPCs)
  ├── wallet.go                    Wallet manager
  ├── balance.go                   Balance fetch + Prometheus export
  ├── onchain_balance.go           Post-fill balance reader (EVM + Solana + HL)
  ├── wallet_snapshot.go           Daily 09:30 P&L cron + tier health grid
  ├── slack.go                     Per-exec, skip, P&L, startup notifs
  ├── pricer.go                    USD pricing
  ├── mobula_bridge.go             Mobula integration
  ├── relay_bridge.go              Relay integration
  ├── lifi_bridge.go               Li.Fi integration
  └── debridge_bridge.go           Debridge integration (quote-only)

cmd/rebalance/                     Manual one-shot rebalance tool (unused in prod)

Dockerfile                         Multi-stage Go build
.env.example                       Documented env vars
```

## Bridge integration details

### Mobula

- Quote: `GET /api/2/bridge/quote?...&apiKey=...`
- TX data: `deposit.solana.serializedTx` (Solana) or `deposit.evm` (EVM)
- 2-step EVM (approve + deposit) handled
- Status: `GET /api/2/bridge/status/{txHash}`, terminal `"settled"`

### Relay

- Quote: `POST /quote` JSON body
- TX data: `steps[].items[].data.instructions[]` (Solana) or `steps[].items[].data` (EVM)
- 2-step EVM (approve + deposit) handled. iterates `steps[]` to find approve before deposit
- Request ID: `steps[].requestId` (deposit step)
- Status: `GET /intents/status/v3?requestId=...`

### Li.Fi

- Quote: `GET /v1/quote?...` with `x-lifi-api-key` header
- TX data: `transactionRequest.data` (Solana base64) or `transactionRequest` (EVM)
- Approval address: `estimate.approvalAddress` (EVM)
- Status: `GET /v1/status?txHash=...&fromChain=...&toChain=...`

### Debridge

- Quote only. execution disabled because flat native-token fees make $5 tickets unprofitable.

## Wallet funding (production mode only)

| Chain | Token | Minimum | Purpose |
| --- | --- | --- | --- |
| Solana | SOL | $5 | Gas (~$0.01/TX) |
| Solana | USDC | $T for tier $T | R1 source |
| Solana | TRUMP | $20+ | R4 (weekly $5) |
| Base | USDC | $0+ (R1 auto-fills before R2 needs it) | R2 source |
| Base | ETH | $5 | Gas (~$0.10/TX) |
| Arbitrum | USDT | $0+ (R2 auto-fills before R3 needs it) | R3 source |
| Arbitrum | ETH | $5 | Gas (~$0.10/TX) |

Pre-flight `SimulateTriangleCycle` checks the 1× threshold before every scheduled tier. non-viable tiers skip cleanly with a single Slack message.

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `MOBULA_API_KEY` | yes | Quotes + balance API |
| `LIFI_API_KEY` | recommended | Better rate limits |
| `RELAY_API_KEY` | optional | Public quotes work without it |
| `WALLET_EVM_PRIVATE_KEY` | for prod | Hex `0x...` |
| `WALLET_EVM_ADDRESS` | for prod | |
| `WALLET_SOL_PRIVATE_KEY` | for prod | Base58 |
| `WALLET_SOL_ADDRESS` | for prod | |
| `EXECUTION_MODE` | yes | `dry-run` / `single-test` / `production` |
| `TEST_AMOUNT_USD` | for `single-test` | Default $1 |
| `MAX_DAILY_SPEND_USD` | no | Safety cap, default $10 |
| `MONITOR_REGION` | yes | Metric label |
| `METRICS_PORT` | no | Default 9090 |
| `SLACK_WEBHOOK_URL` | optional | Direct Slack notifs from the monitor |
| `SOLANA_RPC` / `BASE_RPC` / `ARB_RPC` | no | Override public RPCs |

## Safety features

1. **Per-tier pre-flight**. full cycle simulated before execution, skip cleanly if not viable.
2. **Per-route balance check**. secondary guard during `RunReal` (1.05× buffer).
3. **Daily spending cap**. `MAX_DAILY_SPEND_USD` hard stops runaway.
4. **Consecutive-failure streak**. 3 fails in a row on the same bridge → critical alert.
5. **Dry-run / single-test default**. no accidental production runs.
6. **EVM revert detection**. TX receipt inspected.
7. **Gas price +50 % bump** on Arbitrum. handles rapid base-fee variance.

## Adding a bridge

1. Create `cmd/monitor/<bridge>_bridge.go` mirroring an existing integration (e.g. `relay_bridge.go`).
2. Implement quote, execute, status methods conforming to the `Bridge` interface.
3. Add API key field to `Config` and `.env.example`.
4. Register the bridge in `main.go`'s bridge list.

## License

MIT. same as the rest of OpenChainBench.
