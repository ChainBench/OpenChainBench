# bridge-flows

Where USDC moves between chains, from public data only. Feeds bench
`usdc-corridor-flows` (279). Three sources, all free and keyless:

1. **Circle CCTP burns.** A CCTP transfer burns USDC on the source chain
   (`DepositForBurn` on the TokenMessenger, v1 and v2) and mints it on the
   destination; the burn event carries the amount and the destination
   domain. The harness reads those logs off each scanned chain over a
   public RPC, buckets them per hour and per destination, and publishes
   24h and 7d windows: outflow per corridor, outflow per chain, inflow per
   chain (from the scanned sources only) and the net.
2. **Wormhole.** Wormholescan's `x-chain-activity/tops` gives the USD volume
   that left each chain over Wormhole per UTC day (values scaled by 1e8;
   checked against the scorecards' rolling 24h figure on 2026-09-25).
3. **L2Beat TVS.** The bridged part of each L2's value secured (canonical
   plus external, native excluded) and its change over 24h and 7d.

Not covered: every other bridge (Across, Stargate, LayerZero OFTs, deBridge,
Relay, native L2 bridges other than through L2Beat's aggregate), EURC over
CCTP, and CCTP burns whose source is a chain not in the registry (Solana,
Sui, Aptos and the smaller EVM domains): those chains appear as
destinations of the scanned chains' burns, not as sources. The spec says
so; treat the CCTP numbers as "USDC over Circle's bridge among these seven
chains", not as total cross-chain flow.

## Scanned chains (`config.go`)

Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Unichain. Per
chain: CCTP domain, the native USDC address (the burnToken filter), the v1
TokenMessenger and TokenMessengerV2 (same address on every EVM chain), the
RPC list and the largest block window the first RPC accepted on 2026-09-25.
Override RPCs with `BRIDGE_FLOWS_RPC_<SLUG>=url1,url2`. Public endpoints
that answered `eth_getLogs` over thousands of blocks from the OCB VPS:
Tenderly public gateways, `mainnet.base.org`, `arb1.arbitrum.io/rpc`,
`mainnet.optimism.io`, `api.avax.network`, `mainnet.unichain.org`,
`rpc.mevblocker.io`. dRPC public answered 400 to this client; publicnode,
1rpc, ankr, llamarpc, blockpi refuse getLogs.

## How the scan works

- Cold start: estimate the block `HISTORY_HOURS` (8 days) back from the
  chain's block time, then walk forward in chunks of at most `MaxChunk`
  blocks. A range refusal halves the chunk; it grows back slowly.
- Each chunk fetches the timestamps of its first and last block and
  interpolates the burn's time linearly, which is exact enough for hourly
  buckets.
- State (`/data/state.json`): per chain the cursor and the hourly buckets
  `{usd, burns}` per destination domain. Restarts resume at the cursor.
- Every tick (30 min) scans every chain to the head minus a 3-block reorg
  margin, saves, and republishes. A chain whose scan failed keeps its
  previous gauges (health 0), it is never published as zero flow. Inflow
  and net are published only when every scanned chain is healthy, since a
  missing source would understate everyone else's inflow.

## Metrics

| Gauge | Labels | Meaning |
|---|---|---|
| `bridge_usdc_out_usd` | source, destination, window | USDC burned on source for destination, 24h / 7d |
| `bridge_usdc_out_total_usd` | chain, window | USDC that left the chain over CCTP |
| `bridge_usdc_in_usd` | chain, window | USDC sent to the chain from the scanned sources |
| `bridge_usdc_net_usd` | chain, window | in minus out, scanned chains only |
| `bridge_usdc_burns` | source, window | number of burns |
| `bridge_flows_source_health` | chain | 1 when the last scan reached the head |
| `bridge_flows_source_lag_blocks` | chain | head minus cursor after the tick |
| `bridge_wormhole_volume_usd` | chain, window | Wormhole outbound volume, 24h = last complete UTC day, 7d = last 7 |
| `bridge_wormhole_days_sampled` | | days behind the 7d sums |
| `bridge_l2_tvs_change_usd` | chain, window | change of L2Beat canonical + external |
| `bridge_l2_bridged_value_usd` | chain | L2Beat canonical + external, newest point |
| `bridge_flows_last_tick_unix`, `bridge_wormhole_last_tick_unix`, `bridge_l2beat_last_tick_unix` | | liveness per source |
| `bridge_flows_rpc_calls_total`, `bridge_flows_fetch_total`, `bridge_flows_burns_folded_total` | | counters |

## Run

```
go run ./cmd/script            # :2112/metrics, /health, /logs (LOGS_TOKEN)
STATE_FILE=./state.json TICK=30m HISTORY_HOURS=192 REQUEST_GAP=120ms
```

Docker: `docker build -t ocb-bridge-flows .` then run with `-v <dir>:/data`
writable by uid 65532. Cold start is roughly 600 to 1,000 RPC calls across
the seven chains; a tick after that is a handful of calls per chain.
