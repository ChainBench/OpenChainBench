# transaction-fee

Bench harness: current native-transfer transaction fee per L1, in USD.

Samples 11 L1 chains every 30 s and exposes Prometheus gauges:

- `tx_fee_native_transfer_usd{chain, tier}` — headline (slow / std / fast, or `single` for deterministic chains)
- `tx_fee_native_transfer_native{chain, tier}` — same value in the chain's smallest unit
- `tx_fee_gas_price_gwei{chain, tier}` — EVM only
- `tx_fee_native_token_price_usd{chain}` — USD price used for the conversion
- `tx_fee_last_refresh_timestamp_seconds{chain}` — freshness
- `tx_fee_health{chain}` — 1 if last sample succeeded
- `tx_fee_fetch_errors_total{chain, error_type}` — counter

## Chains tracked

Same list as the L1 finality bench (`miniapps/l1-finality/`):

| Slug | Kind | Method |
|---|---|---|
| ethereum | EVM | `eth_feeHistory` × 21000 gas |
| bnb | EVM | `eth_feeHistory` × 21000 gas |
| avalanche | EVM | `eth_feeHistory` × 21000 gas |
| solana | Solana | 5000 lamport base + `getRecentPrioritizationFees` × 200 CU |
| tron | TRON | `getChainParameters.getTransactionFee` × 268 bytes (bandwidth) |
| cardano | Cardano | live `min_fee_a/b` from Koios × 250 bytes typical |
| stellar | Stellar | `fee_stats.last_ledger_base_fee` (100 stroops baseline) |
| sui | Sui | `suix_getReferenceGasPrice` × 2_000_000 gas budget |
| ton | TON | hardcoded 0.005 TON (typical observed) |
| litecoin | UTXO | `litecoinspace.org/api/v1/fees/recommended` × 225 vBytes |
| monero | Monero | `get_fee_estimate.fees[0..2]` × 1500 bytes |

## Environment

- `MOBULA_API_KEY` — required for USD prices via `api.mobula.io/api/1/market/multi-data`
- `RPC_<CHAIN>` — optional overrides for each chain's endpoint (defaults in `config.go`)

## Local run

```bash
MOBULA_API_KEY=... go run ./cmd/script
curl localhost:2112/metrics | grep tx_fee_native_transfer_usd
```

## Bench page

OpenChainBench: `https://openchainbench.com/benchmarks/network-fees` (after dev → main merge).
