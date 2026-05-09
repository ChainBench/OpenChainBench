# wallet-labels harness

Bench №008 — wallet label coverage across providers.

Subscribes to Mobula Pulse V2 swap stream, captures fresh trader
addresses, and queries every supported provider for an entity label.
Emits Prometheus metrics consumed by openchainbench.com.

## Providers (v1)

| Provider | Auth | Chains |
|---|---|---|
| Mobula | API key | 90+ (multi-chain) |
| Moralis | API key | EVM (eth/base/bnb/polygon/arbitrum/optimism/avalanche) |
| Helius | API key | Solana |
| Blockscout | none | ethereum, base, optimism, polygon, gnosis |
| OLI (Open Labels Initiative) | none | EVM via Base EAS |
| TonAPI | none | TON |
| StellarExpert | none | Stellar |
| XRPScan | none | XRP |
| WalletExplorer | none | Bitcoin |

## Run

```bash
cp .env.example .env
# fill in keys

# build + smoke test
go build ./cmd/script
./script --test            # runs canned test cases against every provider

# run full harness
./script
```

## Endpoints

- `:2112/metrics` — Prometheus scrape
- `:2112/logs?tail=N` — last N log lines (token-gated if `LOGS_TOKEN` set)
- `:2112/debug/wallet-labels` — last 50 raw responses per provider

## Metrics

| Metric | Labels | Type |
|---|---|---|
| `wallet_labels_checks_total` | provider, chain | counter |
| `wallet_labels_success_total` | provider, chain | counter |
| `wallet_labels_api_latency_milliseconds` | provider | histogram |
| `wallet_labels_fetch_errors_total` | provider, error_type | counter |
| `wallet_labels_health` | provider | gauge |
| `wallet_labels_queue_depth` | — | gauge |

Coverage rate per provider/chain:
```
100 * sum(rate(wallet_labels_success_total{provider="X", chain="Y"}[24h]))
    / sum(rate(wallet_labels_checks_total{provider="X", chain="Y"}[24h]))
```
