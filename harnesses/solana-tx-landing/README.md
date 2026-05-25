# solana-tx-landing harness

Source for two OpenChainBench benches that share a single binary:

- [`solana-tx-landing`](https://openchainbench.com/benchmarks/solana-tx-landing) — observational market-share view of Solana transaction landing services (Jito, Helius Sender, Nozomi, Astralane, 0slot, etc.) measured via on-chain tip-wallet attribution.
- [`solana-tx-landing-latency`](https://openchainbench.com/benchmarks/solana-tx-landing-latency) — active probing: a synthetic 1-lamport self-transfer submitted through each service, timing the slot delta to confirmation. See [`docs/methodology/solana-tx-landing-active.md`](../../docs/methodology/solana-tx-landing-active.md) for the pre-registered methodology.

Exposes Prometheus metrics on `:2112/metrics` (OCB Railway convention).

## How it works

Two loops run inside one Go binary:

1. **Observational** (always on). A Solana mainnet WebSocket subscriber watches every block, attributes each transaction to a known landing-service tip wallet, and emits `solana_landing_tx_total{service, wallet}` counters. The market-share bench reads these.
2. **Active probing** (opt-in via `SOLANA_PROBE_KEYPAIR_BASE58`). Once per hour the harness builds a fixed-payload tx (50 000 CU limit + 50 000 micro-lamport CU price + 1 lamport self-transfer + tip + memo) and submits it through each enabled service. It then watches Solana for confirmation and records `solana_landing_probe_latency_slots{service}` and a few presence counters. The latency bench reads these.

When `SOLANA_PROBE_KEYPAIR_BASE58` is unset the harness logs `[prober] disabled` and runs in observational-only mode, no transactions, no SOL spent.

## Metrics

```
solana_landing_tx_total{service, wallet}                          counter — observational tip-wallet attribution
solana_landing_subscription_health{node}                          gauge   — 1 if WS subscription alive
solana_landing_probe_latency_slots{service}                       gauge   — slot delta from submit to confirmation
solana_landing_probe_success_total{service}                       counter
solana_landing_probe_dropped_total{service}                       counter
solana_landing_probe_keypair_balance_sol                          gauge   — funding wallet balance
solana_landing_probe_last_cycle_timestamp_seconds                 gauge   — freshness signal for the cron health-check
```

## Run locally

```bash
cd cmd/script
go run .             # observational-only, no funds required
# OR with probing enabled:
SOLANA_PROBE_KEYPAIR_BASE58=<base58-encoded-secret-key> go run .
```

Or Docker:

```bash
docker build -t solana-tx-landing .
docker run -p 2112:2112 -e SOLANA_PROBE_KEYPAIR_BASE58=... solana-tx-landing
curl localhost:2112/metrics | grep solana_landing
```

## Environment

| Var | Default | Notes |
|---|---|---|
| `PROM_LISTEN_ADDR` | `:2112` | Hardcoded to the OCB Railway scrape convention. Do not rely on `$PORT`. |
| `SOLANA_WS_URL` | mainnet helius default | Public WS endpoint for the block subscriber |
| `SOLANA_HTTP_URL` | mainnet helius default | RPC for the prober's transaction submission + confirmation polling |
| `SOLANA_PROBE_KEYPAIR_BASE58` | (unset) | Base58-encoded 64-byte secret key. **Setting this enables active probing.** Wallet must be funded with ~1 SOL to cover tips + gas across all services for several days |
| `LOGS_TOKEN` | (unset) | Optional, gates `/logs?tail=N` |
| `SLACK_WEBHOOK_URL` | (unset) | Optional, posts probe failures + low-balance alerts |

See [`docs/methodology/solana-tx-landing-active.md`](../../docs/methodology/solana-tx-landing-active.md) for the exact probe payload, tip floors per service, and statistical thresholds.

## Reproducibility

The harness has no off-chain config beyond public RPC endpoints. With a funded keypair anyone can clone, run, and reproduce every number on the two bench pages. No Mobula-internal service required.
