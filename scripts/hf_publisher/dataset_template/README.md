---
license: cc-by-4.0
doi: 10.5281/zenodo.20800311
language:
  - en
language_creators:
  - machine-generated
annotations_creators:
  - machine-generated
multilinguality:
  - monolingual
pretty_name: OpenChainBench Crypto Infrastructure Benchmarks
viewer: true
source_datasets:
  - original
task_categories:
  - time-series-forecasting
  - tabular-regression
  - other
task_ids:
  - univariate-time-series-forecasting
tags:
  - crypto
  - blockchain
  - benchmarks
  - rpc
  - oracles
  - bridges
  - polymarket
  - infrastructure
  - latency
  - finance
  - defi
  - solana
  - ethereum
  - hyperliquid
  - mev
  - observability
  - sla
  - mlcroissant
  - tabular
  - timeseries
  - monitoring
size_categories:
  - 10K<n<100K
  - 100K<n<1M
configs:
  - config_name: headlines
    data_files:
      - split: train
        path: headlines/**/*.parquet
  - config_name: providers
    data_files:
      - split: train
        path: providers/**/*.parquet
  - config_name: timeseries
    data_files:
      - split: train
        path: timeseries/**/*.parquet
  - config_name: chain_leaders
    data_files:
      - split: train
        path: chain_leaders/**/*.parquet
dataset_info:
  - config_name: headlines
    features:
      - name: snapshot_date
        dtype: string
      - name: captured_at
        dtype: string
      - name: slug
        dtype: string
      - name: title
        dtype: string
      - name: category
        dtype: string
      - name: metric
        dtype: string
      - name: unit
        dtype: string
      - name: status
        dtype: string
      - name: value
        dtype: float64
      - name: higher_is_better
        dtype: bool
      - name: leader_name
        dtype: string
      - name: leader_slug
        dtype: string
      - name: leader_value
        dtype: float64
      - name: bench_sample_size
        dtype: float64
      - name: as_of
        dtype: string
      - name: citation_url
        dtype: string
      - name: stat_api_url
        dtype: string
      - name: source_url
        dtype: string
      - name: license
        dtype: string
      - name: schema_version
        dtype: int64
    splits:
      - name: train
  - config_name: providers
    features:
      - name: snapshot_date
        dtype: string
      - name: captured_at
        dtype: string
      - name: bench_slug
        dtype: string
      - name: provider_name
        dtype: string
      - name: provider_slug
        dtype: string
      - name: provider_type
        dtype: string
      - name: provider_layer
        dtype: string
      - name: provider_tag
        dtype: string
      - name: p50
        dtype: float64
      - name: p90
        dtype: float64
      - name: p99
        dtype: float64
      - name: mean
        dtype: float64
      - name: success_rate
        dtype: float64
      - name: provider_sample_size
        dtype: float64
      - name: is_leader
        dtype: bool
      - name: schema_version
        dtype: int64
    splits:
      - name: train
  - config_name: timeseries
    features:
      - name: snapshot_date
        dtype: string
      - name: captured_at
        dtype: string
      - name: bench_slug
        dtype: string
      - name: provider_slug
        dtype: string
      - name: point_index
        dtype: int64
      - name: value
        dtype: float64
      - name: window
        dtype: string
      - name: schema_version
        dtype: int64
    splits:
      - name: train
  - config_name: chain_leaders
    features:
      - name: snapshot_date
        dtype: string
      - name: captured_at
        dtype: string
      - name: bench_slug
        dtype: string
      - name: chain
        dtype: string
      - name: leader_name
        dtype: string
      - name: leader_slug
        dtype: string
      - name: leader_value
        dtype: float64
      - name: worst_name
        dtype: string
      - name: worst_slug
        dtype: string
      - name: worst_value
        dtype: float64
      - name: schema_version
        dtype: int64
    splits:
      - name: train
---

# OpenChainBench Crypto Infrastructure Benchmarks

Daily snapshots of every public benchmark on
[openchainbench.com](https://openchainbench.com), released as
Hive-partitioned Parquet under CC-BY-4.0.

OCB measures latency, cost, coverage and accuracy of crypto
infrastructure (RPCs, oracles, bridges, data APIs, Polymarket adapters,
Hyperliquid builders). Every snapshot here mirrors the
[/api/citable](https://openchainbench.com/api/citable),
[/api/stat/&lt;slug&gt;](https://openchainbench.com/api/stat/bridge-quote-latency),
and [/api/series/&lt;slug&gt;](https://openchainbench.com/api/series/bridge-quote-latency)
JSON feeds at the time of capture.

Latest snapshot: **{{snapshot_date}}** (captured at {{captured_at}}, schema v{{schema_version}}).

## Dataset Description

### Dataset Summary

OpenChainBench publishes reproducible, daily-refreshed performance
benchmarks for crypto infrastructure providers. Each benchmark answers
one operational question (for example, "which RPC has the lowest p50
latency for `eth_getBlockByNumber` on Ethereum?") and reports it as a
ranked leaderboard with p50 / p90 / p99 percentiles, success rate, and
per-provider sample sizes. This dataset is a frozen, ML-friendly
projection of that live data, partitioned by `snapshot_date` so the
full history is queryable from a single Parquet scan.

Use cases the dataset supports:

- Time-series forecasting of provider latency / cost / success rate.
- Tabular regression over provider attributes (type, layer, sample size).
- Reproducibility for citations made on the live site (each row carries
  the same `citation_url` you would link to in a paper or blog post).
- Anomaly detection on infrastructure trajectories across the
  industry-wide registry.
- Powering AI agents that need an authoritative, citable answer to "who
  leads on metric X today?"

### Supported Tasks and Leaderboards

- `time-series-forecasting`: each `(bench_slug, provider_slug, window)`
  tuple in the `timeseries` config is a univariate series suitable for
  forecasting.
- `tabular-regression`: the `providers` config exposes per-provider
  numeric features (p50 / p90 / p99 / mean / success rate / sample
  size) and categorical features (type / layer / tag) per snapshot.
- `other` (information retrieval / agent grounding): the `headlines`
  config is shaped to fit into a single LLM tool call. Agents reading
  it get the headline number, the leader, the methodology link, and the
  citation URL in one row.

A live leaderboard for every benchmark is at
`https://openchainbench.com/benchmarks/<slug>`.

### Languages

The dataset is monolingual: English (`en`). All text fields (title,
category, metric, unit) are English. Provider names are project
trademarks and preserve their original casing.

## Dataset Structure

### Data Instances

Each config is a flat Parquet table partitioned by `snapshot_date`.
A row looks like (headlines):

```json
{
  "snapshot_date": "2026-06-22",
  "captured_at": "2026-06-22T14:37:00+00:00",
  "slug": "bridge-quote-latency",
  "title": "Bridge Quote Latency",
  "category": "Bridges",
  "metric": "Quote Latency",
  "unit": "ms",
  "status": "live",
  "value": 412.0,
  "higher_is_better": false,
  "leader_name": "LI.FI",
  "leader_slug": "lifi",
  "leader_value": 412.0,
  "bench_sample_size": 12480.0,
  "as_of": "2026-06-22T14:30:00.000Z",
  "citation_url": "https://openchainbench.com/benchmarks/bridge-quote-latency",
  "stat_api_url": "https://openchainbench.com/api/stat/bridge-quote-latency",
  "source_url": "https://github.com/ChainBench/OpenChainBench/blob/main/benchmarks/bridge-quote-latency.yml",
  "license": "CC-BY-4.0",
  "schema_version": 2
}
```

### Data Fields

Each config has its own schema. JSON Schema files live alongside this
README under `schemas/`. Tables below are the authoritative source for
column names and nullability.

#### Data Fields, headlines

One row per (slug, snapshot_date). The "who leads" feed.

| Column | Type | Nullable | Description | Example |
|---|---|---|---|---|
| snapshot_date | string | no | Partition key, ISO date (UTC) of the capture | `2026-06-22` |
| captured_at | string | no | ISO 8601 timestamp of the capture | `2026-06-22T14:37:00+00:00` |
| slug | string | no | Benchmark slug, stable URL identifier | `bridge-quote-latency` |
| title | string | no | Human-readable benchmark title | `Bridge Quote Latency` |
| category | string | no | One of `RPCs`, `Bridges`, `Blockchains`, `Aggregators`, `Trading`, `Wallets`, `NFT APIs` | `Bridges` |
| metric | string | no | What is measured | `Quote Latency` |
| unit | string | no | One of `ms`, `s`, `sec`, `pct`, `bps`, `bp`, `count`, `slots`, `usd` | `ms` |
| status | string | no | One of `live`, `draft`, `insufficient` | `live` |
| value | float64 | yes | Headline value of the leader. Null when `status != live` | `412.0` |
| higher_is_better | bool | yes | Direction of the metric, sourced from `/api/stat`. Null when the per-slug fetch failed | `false` |
| leader_name | string | yes | Display name of the leading provider | `LI.FI` |
| leader_slug | string | yes | URL-safe slug of the leading provider | `lifi` |
| leader_value | float64 | yes | Leader's value in `unit` | `412.0` |
| bench_sample_size | float64 | yes | Aggregate sample count over the bench's run window | `12480.0` |
| as_of | string | yes | Source-side timestamp of the underlying measurement | `2026-06-22T14:30:00.000Z` |
| citation_url | string | no | Canonical citation URL for the benchmark | `https://openchainbench.com/benchmarks/bridge-quote-latency` |
| stat_api_url | string | no | Per-bench live JSON endpoint | `https://openchainbench.com/api/stat/bridge-quote-latency` |
| source_url | string | yes | URL of the bench YAML spec in this repo | `https://github.com/ChainBench/OpenChainBench/blob/main/benchmarks/bridge-quote-latency.yml` |
| license | string | no | Always `CC-BY-4.0` for the data | `CC-BY-4.0` |
| schema_version | int64 | no | Additive schema epoch, bumped on new columns | `2` |

#### Data Fields, providers

One row per (bench, provider, snapshot_date). Per-provider rankings.

| Column | Type | Nullable | Description | Example |
|---|---|---|---|---|
| snapshot_date | string | no | Partition key | `2026-06-22` |
| captured_at | string | no | ISO 8601 capture timestamp | `2026-06-22T14:37:00+00:00` |
| bench_slug | string | no | Foreign key into `headlines.slug` | `bridge-quote-latency` |
| provider_name | string | no | Display name of the provider | `LI.FI` |
| provider_slug | string | no | URL-safe provider slug, stable across snapshots | `lifi` |
| provider_type | string | yes | Architectural category (e.g. `aggregator`, `node-rpc`, `oracle`) | `aggregator` |
| provider_layer | string | yes | Network layer when declared (`L1`, `L2`, etc.) | `L1` |
| provider_tag | string | yes | Free-form tag from the bench YAML | `premium` |
| p50 | float64 | yes | 50th percentile in the bench's `unit` | `412.0` |
| p90 | float64 | yes | 90th percentile | `780.0` |
| p99 | float64 | yes | 99th percentile | `1230.0` |
| mean | float64 | yes | Arithmetic mean | `465.3` |
| success_rate | float64 | yes | Fraction (0..1) or percent (0..100) per bench convention | `0.997` |
| provider_sample_size | float64 | yes | Per-provider sample count over the run window | `2080.0` |
| is_leader | bool | no | True for the provider whose slug matches `headlines.leader_slug` | `true` |
| schema_version | int64 | no | Schema epoch | `2` |

#### Data Fields, timeseries

One row per (bench, provider, window, point_index, snapshot_date). The
24h, 7d, and 30d trajectories sourced from `/api/series`.

| Column | Type | Nullable | Description | Example |
|---|---|---|---|---|
| snapshot_date | string | no | Partition key | `2026-06-22` |
| captured_at | string | no | ISO 8601 capture timestamp | `2026-06-22T14:37:00+00:00` |
| bench_slug | string | no | Foreign key into `headlines.slug` | `bridge-quote-latency` |
| provider_slug | string | yes | Provider this point belongs to. Null only on legacy 24h fallback rows that predate per-provider series | `lifi` |
| point_index | int64 | no | Zero-based index inside the window | `42` |
| value | float64 | no | Value of the metric at this point, in the bench's `unit` | `423.7` |
| window | string | no | One of `24h`, `7d`, `30d` | `24h` |
| schema_version | int64 | no | Schema epoch | `2` |

#### Data Fields, chain_leaders

One row per (bench, chain, snapshot_date). Per-chain leader and worst
provider for benches whose spec declares a chain dimension. Currently
empty: see "Considerations for Using the Data" for the open task.

| Column | Type | Nullable | Description | Example |
|---|---|---|---|---|
| snapshot_date | string | no | Partition key | `2026-06-22` |
| captured_at | string | no | ISO 8601 capture timestamp | `2026-06-22T14:37:00+00:00` |
| bench_slug | string | no | Foreign key into `headlines.slug` | `eth-rpc-head-lag` |
| chain | string | no | Chain slug from the bench spec | `ethereum` |
| leader_name | string | yes | Best provider on this chain | `Mobula` |
| leader_slug | string | yes | URL-safe leader slug | `mobula` |
| leader_value | float64 | yes | Leader's value on this chain | `87.2` |
| worst_name | string | yes | Worst provider on this chain | `LegacyRPC` |
| worst_slug | string | yes | URL-safe worst slug | `legacyrpc` |
| worst_value | float64 | yes | Worst provider's value | `1421.3` |
| schema_version | int64 | no | Schema epoch | `2` |

### Data Splits

Every config exposes a single `train` split. There is no held-out
evaluation split because the dataset is observational: it records
measurements as they happen and downstream users define their own
train / test cuts (typically by `snapshot_date`).

## Dataset Creation

### Curation Rationale

The OpenChainBench site renders human-readable leaderboards but its
underlying JSON feeds are designed to be agent-friendly: every value
is paired with a methodology link, a license, and a sample size. This
dataset freezes those feeds daily so:

- LLM agents and journalists can cite a deterministic snapshot.
- ML researchers can train models without depending on a live API
  whose numbers move every minute.
- Operators can compare today's leader against arbitrary historical
  baselines without rebuilding the harness.

### Source Data

#### Initial Data Collection and Normalization

Raw measurements are collected by per-bench harnesses (open-sourced in
the [OpenChainBench GitHub repo](https://github.com/ChainBench/OpenChainBench)
or, for a few benches, in a private mobula-api repo where they exist
behind paid API keys). Harnesses publish Prometheus metrics that the
OCB Next.js app aggregates into a `Benchmark` object per bench.

The dataset publisher reads from:

- `https://openchainbench.com/api/citable` for the headline feed.
- `https://openchainbench.com/api/stat/<slug>` for per-bench detail
  (provider rankings, sparkline, `higherIsBetter`).
- `https://openchainbench.com/api/series/<slug>?range=<window>` for the
  24h / 7d / 30d per-provider trajectories.

Each per-bench page documents its full methodology. The
`citation_url` column of `headlines` is the stable link to that page.

#### Who are the source language producers?

All text fields (titles, methodology copy, category labels) are
authored by OpenChainBench contributors in the YAML benchmark specs
under `benchmarks/` in the GitHub repo. The data values themselves are
machine-generated by the measurement harnesses.

### Annotations

The dataset has no human-applied annotation layer. Provider rankings
and leader flags are derived programmatically from the percentile
measurements according to each bench's `higher_is_better` direction.

#### Annotation process

The OCB Next.js layer computes the leader as the provider with the
best `p50` according to the bench's direction. `bestPerChain` and
`worstPerChain` (when populated) are computed with the same rule
scoped to chain-restricted samples. The `is_leader` boolean in the
`providers` table is a derived projection of `headlines.leader_slug`.

#### Who are the annotators?

There are no human annotators. Categorical fields like `category`,
`metric`, `unit`, `provider_type`, and `provider_layer` are authored
by the bench YAML maintainers and reviewed via the same PR process as
the harness code.

### Personal and Sensitive Information

The dataset contains no personal or sensitive information. Provider
identifiers refer to operational entities (companies, networks, public
APIs) and are publicly listed on the OpenChainBench site.

## Considerations for Using the Data

### Social Impact of Dataset

Public, reproducible measurements of crypto infrastructure raise the
bar for operator transparency. Downstream consumers should not, however,
treat any single snapshot as definitive: providers' production
characteristics change with traffic, deployments, and incident
recovery.

### Discussion of Biases

- **Vantage bias**: latency benchmarks are scraped from a small set of
  Prometheus harnesses located in specific cloud regions. The exact
  vantage points and methodology are documented per bench at
  `citation_url`.
- **Sample asymmetry**: providers that rate-limit our probes hard end
  up with smaller `provider_sample_size` than providers that allow
  generous quotas. This biases percentile estimates upward (fewer
  samples surface tail latency less reliably). The `is_leader` flag is
  derived purely from the p50 figure and may therefore reflect
  measurement-side asymmetry, not just provider performance.
- **Aggregator coverage**: providers that wrap multiple upstream APIs
  (aggregators, with `provider_type = "aggregator"`) compete on a
  different surface than single-vendor providers and are not strictly
  apples-to-apples comparable. The `provider_type` column is meant to
  let consumers filter or stratify by this distinction.

### Other Known Limitations

- **Schema stability promise (additive only)**: new columns may be
  added without warning. Consumer queries should select named columns
  rather than `SELECT *`. Existing columns are never renamed or
  removed within a `schema_version`. If a breaking change is
  unavoidable, a parallel v3 / v4 folder ships alongside the v2
  partitions so old consumers keep working.
- **`chain_leaders` is currently empty**: the `bestPerChain` /
  `worstPerChain` data exists inside the OCB aggregator but is not
  exposed by `/api/citable` or `/api/stat` yet. The table is shipped
  with its canonical schema so downstream pipelines can stabilize
  against a real (zero-row) parquet today and start receiving rows
  as soon as the API surfaces the field. Tracked in the publisher's
  source code as a `TODO`.
- **24h legacy fallback**: when `/api/series` returns no payload for a
  bench's 24h window, the publisher falls back to the aggregate
  `sparkline` from `/api/stat`. Those fallback rows carry the leader's
  `provider_slug` rather than a per-provider series; downstream users
  who care about per-provider trajectories should filter on `window in
  ('7d', '30d')` or join `provider_slug` against the `providers`
  config.
- **Quorum guard**: if the source feed reports fewer than half its
  benches as `live` on capture day, the publisher refuses to upload a
  new partition. The previous good snapshot stays as truth that day.

## Additional Information

### Dataset Curators

OpenChainBench Contributors. The publishing pipeline is open source
under the Apache 2.0 license at
[github.com/ChainBench/OpenChainBench](https://github.com/ChainBench/OpenChainBench)
(see `scripts/hf_publisher/`).

### Licensing Information

Data is released under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
You may use it freely with attribution to OpenChainBench.

The publishing scripts and benchmark YAML specs are released under
Apache 2.0.

### Citation Information

The dataset is archived on Zenodo with a permanent DOI. Use the concept
DOI when citing the dataset in general (it always resolves to the latest
version). Use the version DOI when citing a specific snapshot for
reproducibility.

- Concept DOI: [10.5281/zenodo.20800311](https://doi.org/10.5281/zenodo.20800311)
- v1.0.1 version DOI: [10.5281/zenodo.20800312](https://doi.org/10.5281/zenodo.20800312)

Suggested attribution string:

> OpenChainBench. (2026). OpenChainBench Crypto Infrastructure Benchmarks
> [Data set]. Zenodo. https://doi.org/10.5281/zenodo.20800311

BibTeX:

```bibtex
@dataset{openchainbench_2026,
  author    = {{OpenChainBench Contributors}},
  title     = {OpenChainBench Crypto Infrastructure Benchmarks},
  year      = {2026},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.20800311},
  url       = {https://doi.org/10.5281/zenodo.20800311},
  note      = {Live mirror at https://huggingface.co/datasets/OpenChainBench/benchmarks}
}
```

A machine-readable `CITATION.cff` is also published at the root of
this dataset; GitHub, HF, and Zenodo all parse it.

### Contributions

Bug reports, schema requests, and new benchmark proposals go through
GitHub Issues at
[github.com/ChainBench/OpenChainBench/issues](https://github.com/ChainBench/OpenChainBench/issues).
Benchmarks are contributed as YAML files plus a Prometheus-emitting
harness; the contributor guide is in
[CONTRIBUTING.md](https://github.com/ChainBench/OpenChainBench/blob/main/CONTRIBUTING.md).

## Quick start

### Python (datasets)

```python
from datasets import load_dataset
ds = load_dataset("OpenChainBench/benchmarks", "headlines", split="train")
print(ds.filter(lambda r: r["slug"] == "bridge-quote-latency")[0])
```

### Polars (recommended for analytics)

```python
import polars as pl
df = pl.scan_parquet(
    "hf://datasets/OpenChainBench/benchmarks/headlines/**/*.parquet"
)
latest = (
    df.filter(pl.col("snapshot_date") == df.select(pl.col("snapshot_date").max()).collect().item())
      .select(["slug", "leader_name", "value", "unit"])
      .collect()
)
print(latest)
```

### DuckDB (one-liner)

```sql
SELECT slug, leader_name, value, unit
FROM 'hf://datasets/OpenChainBench/benchmarks/headlines/**/*.parquet'
WHERE snapshot_date = (
  SELECT max(snapshot_date)
  FROM 'hf://datasets/OpenChainBench/benchmarks/headlines/**/*.parquet'
);
```

More examples in `examples/`.

## Update cadence

Snapshots run daily at 00:00 UTC via a GitHub Action. If a run aborts
on a quorum check (the source feed has fewer than half its benches
live), no new partition is added that day. The previous good snapshot
stays as truth.

## Provenance

- Source code (publisher + benchmark YAML specs): https://github.com/ChainBench/OpenChainBench
- Live measurement APIs: https://openchainbench.com/api/citable, /api/stat, /api/series, /api/llm-context, /api/mcp/mcp
- Issues / questions: https://github.com/ChainBench/OpenChainBench/issues
