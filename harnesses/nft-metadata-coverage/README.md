# nft-metadata-coverage

OpenChainBench harness that scores collection-level metadata coverage for the
4 Ethereum NFT indexers we audit: **Moralis**, **Alchemy**, **OpenSea**, and
**Rarible**.

## What it does

Every 6 hours (configurable) the harness walks a hardcoded list of 50 blue-chip
Ethereum collections (BAYC, CryptoPunks, Pudgy Penguins, Azuki, etc.) and for
each one fetches the collection metadata from all 4 providers in parallel. It
then scores 5 fields per provider:

| Field          | Counts as present when               |
| -------------- | ------------------------------------ |
| `name`         | non-empty string                     |
| `image`        | non-empty URL                        |
| `description`  | non-empty string                     |
| `floor_eth`    | positive number                      |
| `external_url` | non-empty URL                        |

Per-provider field mapping (locked from apple-to-apple validation in
`/tmp/nft-validation/`):

- **Moralis**: `name`, `collection_logo`, `description`, `floor_price` (string),
  `project_url`
- **Alchemy**: `name`, `openSeaMetadata.imageUrl`, `openSeaMetadata.description`,
  `openSeaMetadata.floorPrice`, `openSeaMetadata.externalUrl`
- **OpenSea**: 2 calls per collection — `/collections/{slug}` then
  `/collections/{slug}/stats`. The slug is pre-resolved live at startup from
  the contract address via `/chain/ethereum/contract/{contract}`.
- **Rarible**: `meta.name`, first `meta.content[]` entry where `@type=="IMAGE"`,
  `meta.description`, `meta.externalLink`. Rarible's `floor_eth` is
  **deliberately skipped** because the endpoint only exposes a bid-side floor
  (`bestBidOrder`), not an ask-side floor — counting it would unfairly punish
  the venue on apple-to-apple scoring.

## Prometheus metrics on `:2112/metrics`

- `nft_metadata_checks_total{provider, collection, field, region}` (counter)
- `nft_metadata_success_total{provider, collection, field, region}` (counter)
- `nft_metadata_latency_milliseconds{provider, region}` (histogram)
- `nft_metadata_errors_total{provider, error_type, region}` (counter)

## Env vars

| Name                    | Required | Default   |
| ----------------------- | -------- | --------- |
| `MORALIS_API_KEY`       | yes      | (none)    |
| `ALCHEMY_API_KEY`       | yes      | (none)    |
| `OPENSEA_API_KEY`       | yes      | (none)    |
| `RARIBLE_API_KEY`       | yes      | (none)    |
| `MONITOR_REGION`        | no       | `eu-west` |
| `REFRESH_INTERVAL_HOURS`| no       | `6`       |
| `LOGS_TOKEN`            | no       | (disabled)|

## Run locally

```bash
cd miniapps/nft-metadata-coverage
go build -o cmd/script/script ./cmd/script

# One-shot smoke run (10 validated collections, then idles waiting for SIGINT)
MORALIS_API_KEY=... \
  ALCHEMY_API_KEY=... \
  OPENSEA_API_KEY=... \
  RARIBLE_API_KEY=... \
  ./cmd/script/script --smoke
```

## /logs endpoint

Set `LOGS_TOKEN=<secret>`, then:

```bash
curl -s -H "X-Logs-Token: <secret>" "http://localhost:2112/logs?tail=200"
```

## Rate-limit plan

| Provider | Plan                                                |
| -------- | --------------------------------------------------- |
| Moralis  | parallel, generous                                  |
| Alchemy  | parallel, generous                                  |
| OpenSea  | serial, ~650 ms between calls (60 req/min cap, 2 calls per collection) |
| Rarible  | serial, 1 req/sec                                   |

Wall-clock per cycle at 50 collections: ~110s OpenSea + ~50s Rarible, both
serial, gated by their slower-of-two. Moralis/Alchemy fire in parallel inside
the same per-collection iteration.
