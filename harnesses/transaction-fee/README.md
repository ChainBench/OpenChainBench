# transaction-fee

Bench harness: current native-transfer transaction fee per L1, in USD.

Samples every chain in `cmd/script/config.go` (Layer 1 and Layer 2) every 30 s and exposes Prometheus gauges:

- `tx_fee_native_transfer_usd{chain, tier}` — headline (slow / std / fast, or `single` for deterministic chains)
- `tx_fee_native_transfer_native{chain, tier}` — same value in the chain's smallest unit
- `tx_fee_gas_price_gwei{chain, tier}` — EVM only
- `tx_fee_native_token_price_usd{chain}` — USD price used for the conversion
- `tx_fee_last_refresh_timestamp_seconds{chain}` — freshness
- `tx_fee_health{chain}` — 1 if last sample succeeded
- `tx_fee_fetch_errors_total{chain, error_type}` — counter

## Chains tracked

Layer 1 (the EVM rollups on the L2 tab are listed in `config.go`; they use the EVM flow plus an L1 data fee per rollup):

| Slug | Kind | Method |
|---|---|---|
| ethereum, bnb, avalanche, sei, cronos, kaia, somnia | EVM | `eth_feeHistory` (median of 4 blocks per percentile) × 21000 gas |
| solana | Solana | 5000 lamport base + `getRecentPrioritizationFees` × 200 CU |
| tron | TRON | `getChainParameters.getTransactionFee` × 268 bytes (bandwidth) |
| cardano | Cardano | live `min_fee_a/b` from Koios × 250 bytes typical |
| stellar | Stellar | `fee_stats.last_ledger_base_fee` (100 stroops baseline) |
| sui | Sui | GraphQL reference gas price × 1000 units + 988000 MIST storage of the new coin object |
| gram | TON | hardcoded 0.005 GRAM (typical observed) |
| litecoin | UTXO | `litecoinspace.org/api/v1/fees/recommended` × 225 vBytes |
| monero | Monero | `get_fee_estimate.fees[0..2]` × 1500 bytes |
| algorand | Algorand | algod `/v2/transactions/params`: max(min-fee, fee × 250 bytes) |
| aptos | Aptos | `/v1/estimate_gas_price` (3 tiers) × 63 gas units |
| near | NEAR | `gas_price` × transfer gas from `EXPERIMENTAL_protocol_config` (cached 1 h) |
| icp | ICP | ledger transfer fee from Rosetta `/construction/metadata` (10000 e8s) |

## Environment

- `MOBULA_API_KEY` (required): USD prices via `api.mobula.io/api/1/market/multi-data`, by slug (`assets=`) or by numeric Mobula asset id (`ids=`). Ids survive renames; the `toncoin` slug stopped resolving after Mobula renamed it to Gram.
- `RPC_<CHAIN>` — optional overrides for each chain's endpoint (defaults in `config.go`)

## Local run

```bash
MOBULA_API_KEY=... go run ./cmd/script
curl localhost:2112/metrics | grep tx_fee_native_transfer_usd
```

## Bench page

OpenChainBench: `https://openchainbench.com/benchmarks/network-fees` (after dev → main merge).
