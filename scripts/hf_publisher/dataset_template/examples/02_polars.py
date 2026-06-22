"""
Stream the OCB providers feed with Polars directly from HF. Pushdown
predicate + projection means only the columns and partitions you ask
for ever hit the wire. Recommended for analytic workloads.
"""

import polars as pl

providers = pl.scan_parquet(
    "hf://datasets/OpenChainBench/benchmarks/providers/**/*.parquet"
)

# Trend of Mobula's p50 latency on bridge-quote-latency across all snapshots
trend = (
    providers.filter(
        (pl.col("bench_slug") == "bridge-quote-latency")
        & (pl.col("provider_slug") == "mobula")
    )
    .select(["snapshot_date", "p50", "p90", "p99", "sample_size"])
    .sort("snapshot_date")
    .collect()
)
print(trend)
