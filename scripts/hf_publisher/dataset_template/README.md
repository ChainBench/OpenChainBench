---
license: cc-by-4.0
language:
  - en
pretty_name: OpenChainBench Benchmarks
task_categories:
  - tabular-classification
  - other
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
size_categories:
  - 1K<n<10K
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
---

# OpenChainBench Benchmarks

Daily snapshots of every public benchmark on
[openchainbench.com](https://openchainbench.com), released as
Hive-partitioned Parquet under CC-BY-4.0.

OCB measures latency, cost, coverage and accuracy of crypto
infrastructure (RPCs, oracles, bridges, data APIs, Polymarket adapters,
Hyperliquid builders). Every snapshot here mirrors the
[/api/citable](https://openchainbench.com/api/citable) and
[/api/stat/&lt;slug&gt;](https://openchainbench.com/api/stat/bridge-quote-latency)
JSON feeds at the time of capture.

Latest snapshot: **{{snapshot_date}}** (captured at {{captured_at}}, schema v{{schema_version}}).

## Tables

| Config | Grain | What's in it |
|---|---|---|
| `headlines` | 1 row per (bench, day) | Title, metric, leader, headline value, license, source URL |
| `providers` | 1 row per (bench, provider, day) | p50/p90/p99, mean, success rate, sample size, is_leader flag |
| `timeseries` | 1 row per (bench, point, day) | 24h sparkline values (~72 points per bench) |

All tables are partitioned by `snapshot_date=YYYY-MM-DD`. Each row also
carries a `captured_at` timestamp (UTC, ISO 8601) and a `schema_version`
integer.

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
WHERE snapshot_date = (SELECT max(snapshot_date) FROM 'hf://datasets/OpenChainBench/benchmarks/headlines/**/*.parquet');
```

More examples in `examples/`.

## Methodology

Each benchmark documents its full methodology on the OCB site (per-bench
URL is in the `citation_url` column of `headlines`). Reading list:

- Per-bench page (open methodology): `https://openchainbench.com/benchmarks/<slug>`
- Site-wide methodology: `https://openchainbench.com/methodology`
- YAML spec source (Apache 2.0): `https://github.com/ChainBench/OpenChainBench/tree/main/benchmarks`

Harness code is open source where applicable (column `source_url`).

## Schema stability promise

- New columns may be added without warning. Consumer queries should
  select named columns rather than `SELECT *`.
- Existing columns will never be renamed or removed. If a breaking
  change ever proves unavoidable, a parallel v2 folder ships alongside
  the v1 partitions so old consumers keep working.
- `schema_version` integer in each row marks the additive schema epoch.

## Update cadence

Snapshots run daily at 00:00 UTC via a GitHub Action. If a run aborts
on a quorum check (the source feed has fewer than half its benches
live), no new partition is added that day - the previous good snapshot
stays as truth.

## License & citation

Data is released under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
Use it freely with attribution to OpenChainBench.

For academic citation see `CITATION.cff` at the root of this dataset
(GitHub / HF / Zenodo all parse it). Suggested attribution string:

> OpenChainBench. (2026). OpenChainBench Benchmarks [Data set].
> Hugging Face. https://huggingface.co/datasets/OpenChainBench/benchmarks

## Provenance

- Source code (publisher + benchmark YAML specs): https://github.com/ChainBench/OpenChainBench
- Live measurement APIs: https://openchainbench.com/api/citable, /api/stat, /api/llm-context, /api/mcp
- Issues / questions: https://github.com/ChainBench/OpenChainBench/issues
