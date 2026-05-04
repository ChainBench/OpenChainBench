# Harness · bridge-fee

> Bridge cost-percent monitor that produces `bridge_cost_percent` metrics consumed by [`benchmarks/bridge-fee.yml`](../../benchmarks/bridge-fee.yml). One Go binary, one Railway service, one benchmark.

**Bench**: [№ 003 · Bridge Effective Fee](../../benchmarks/bridge-fee.yml)

**Tracked bridges**: Mobula · Relay · Li.Fi · Debridge

## How it works

Quote loop runs every 5 minutes: for every route × every notional, each bridge is queried and the total cost (fees + slippage + destination gas) is computed and exported as a percent of notional.

We use `bridge_cost_percent` rather than the narrower `bridge_fees_percent` because some providers bake their fee into the spread and would otherwise appear at 0% — misleading. `bridge_cost_percent` reflects what actually leaves the user's wallet.

## Metrics produced (subset relevant to this bench)

```
bridge_cost_percent{bridge, from_chain, to_chain, from_token, to_token, amount_usd, region}    gauge
bridge_cost_usd{...}                                                                            gauge
bridge_slippage_usd / bridge_gas_usd / bridge_fix_fee_usd{...}                                  gauge
```

## Run locally

```bash
cp .env.example .env
docker-compose -f deploy/docker-compose.yml up -d
```

Or directly:

```bash
go run ./cmd/monitor/
# /metrics on :9090
```

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `MOBULA_API_KEY` | yes | Quotes |
| `LIFI_API_KEY` | recommended | Better rate limits |
| `EXECUTION_MODE` | yes | `dry-run` (recommended for this service) |
| `MONITOR_REGION` | yes | Metric label |

## License

MIT.
