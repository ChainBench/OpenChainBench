"""
Load the OCB headlines feed with pandas via the Hugging Face datasets
library. Good when you want a familiar DataFrame and the dataset is
small enough to fit in memory (it is).
"""

from datasets import load_dataset

ds = load_dataset(
    "OpenChainBench/benchmarks",
    "headlines",
    split="train",
)
df = ds.to_pandas()

# Latest snapshot only
latest = df["snapshot_date"].max()
today = df[df["snapshot_date"] == latest]

# Top 10 benchmarks by sample size today
print(
    today.sort_values("sample_size", ascending=False)[
        ["slug", "leader_name", "value", "unit", "sample_size"]
    ].head(10)
)
