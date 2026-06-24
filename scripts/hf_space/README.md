---
title: OpenChainBench Leaderboard
emoji: 📊
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: 4.44.1
python_version: "3.11"
app_file: app.py
license: cc-by-4.0
pinned: false
short_description: Live leaderboard for OpenChainBench benchmarks
---

# OpenChainBench leaderboard

A small Gradio app that reads the daily parquet snapshot from the
[OpenChainBench/benchmarks](https://huggingface.co/datasets/OpenChainBench/benchmarks)
dataset and lets you browse it. Four tabs: today's leaderboard, per-chain
leaders, per-provider rankings, and an about page.

The dataset itself is the source of truth. This Space is a viewer on top
of it. If you want raw access, query the parquet files directly with
`polars`, `duckdb`, `pandas`, or any tool that speaks parquet.

```python
import polars as pl

df = pl.scan_parquet(
    "hf://datasets/OpenChainBench/benchmarks/headlines/**/*.parquet",
    hive_partitioning=True,
)
print(df.collect().head())
```

For the full website with methodology, per-bench detail pages, and the
historical view, head to [openchainbench.com](https://openchainbench.com).

## Local dev

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:7860.

## License

Code in this Space is part of the OpenChainBench repo. The dataset is
released under CC-BY-4.0. Attribution: link back to openchainbench.com or
the dataset page.
