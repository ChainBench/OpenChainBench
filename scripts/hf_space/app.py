"""
Gradio Space for the OpenChainBench public dataset.

Loads parquet partitions directly from the HF dataset at
hf://datasets/OpenChainBench/benchmarks via polars, surfaces a
sortable / filterable leaderboard, per-chain leaders, and per-provider
rankings. No local cache, no auth, no state. Each tab refresh re-reads
the latest snapshot from HF, which is cheap because polars only scans
the columns it needs.

Run locally:
    pip install -r requirements.txt
    python app.py

The HF Space picks up `app_file: app.py` from README.md frontmatter.
"""

from __future__ import annotations

import functools
import logging
from typing import Any

import gradio as gr
import polars as pl

logger = logging.getLogger("ocb_space")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DATASET_REPO = "OpenChainBench/benchmarks"
DATASET_URL = f"https://huggingface.co/datasets/{DATASET_REPO}"
SITE_URL = "https://openchainbench.com"
GITHUB_URL = "https://github.com/ChainBench/OpenChainBench"

FOOTER = (
    f"Data sourced from {DATASET_URL} (CC-BY-4.0). Updated daily."
)

# Hive partition layout: <table>/snapshot_date=YYYY-MM-DD/part-0.parquet.
# Globbing the partitions and reading only the most recent snapshot_date
# keeps the scan small even as the dataset accumulates history.
HF_BASE = f"hf://datasets/{DATASET_REPO}"


@functools.lru_cache(maxsize=1)
def latest_snapshot_date() -> str:
    """Pick the most recent snapshot_date present in headlines.

    Scans the partition column only, no row data is materialized. Result
    is cached for the lifetime of the process so every tab call reuses
    the same date.
    """
    lf = pl.scan_parquet(f"{HF_BASE}/headlines/**/*.parquet", hive_partitioning=True)
    dates = lf.select("snapshot_date").unique().collect()
    latest = dates["snapshot_date"].max()
    if latest is None:
        raise RuntimeError("no snapshots found in headlines/")
    logger.info("latest snapshot: %s", latest)
    return str(latest)


def _read_table(table: str, snapshot: str) -> pl.DataFrame:
    lf = pl.scan_parquet(
        f"{HF_BASE}/{table}/**/*.parquet", hive_partitioning=True
    ).filter(pl.col("snapshot_date") == snapshot)
    return lf.collect()


@functools.lru_cache(maxsize=1)
def headlines_df() -> pl.DataFrame:
    return _read_table("headlines", latest_snapshot_date())


@functools.lru_cache(maxsize=1)
def providers_df() -> pl.DataFrame:
    return _read_table("providers", latest_snapshot_date())


@functools.lru_cache(maxsize=1)
def chain_leaders_df() -> pl.DataFrame:
    return _read_table("chain_leaders", latest_snapshot_date())


def _categories() -> list[str]:
    df = headlines_df()
    if "category" not in df.columns:
        return ["All"]
    cats = sorted({c for c in df["category"].to_list() if c})
    return ["All", *cats]


def _bench_slugs() -> list[str]:
    df = headlines_df()
    return sorted({s for s in df["slug"].to_list() if s})


def _bench_choices_for_chains() -> list[str]:
    df = chain_leaders_df()
    if df.is_empty():
        return ["All"]
    return ["All", *sorted({s for s in df["bench_slug"].to_list() if s})]


def _chain_choices() -> list[str]:
    df = chain_leaders_df()
    if df.is_empty():
        return ["All"]
    return ["All", *sorted({s for s in df["chain"].to_list() if s})]


def view_headlines(category: str) -> Any:
    df = headlines_df()
    if category and category != "All":
        df = df.filter(pl.col("category") == category)

    # The detail URL pattern on openchainbench.com is /benchmarks/<slug>.
    # We render the title as a markdown link so clicking opens the page
    # in a new tab.
    pdf = (
        df.select(
            [
                pl.col("title").alias("Bench"),
                pl.col("slug"),
                pl.col("category").alias("Category"),
                pl.col("metric").alias("Metric"),
                pl.col("unit").alias("Unit"),
                pl.col("leader_name").alias("Leader"),
                pl.col("leader_value").alias("Leader value"),
                pl.col("bench_sample_size").alias("Sample size"),
                pl.col("as_of").alias("As of"),
            ]
        )
        .sort("Bench")
        .to_pandas()
    )
    pdf["Bench"] = pdf.apply(
        lambda r: f"[{r['Bench']}]({SITE_URL}/benchmarks/{r['slug']})", axis=1
    )
    pdf = pdf.drop(columns=["slug"])
    return pdf


def view_chain_leaders(bench: str, chain: str) -> Any:
    df = chain_leaders_df()
    if df.is_empty():
        return df.to_pandas()
    if bench and bench != "All":
        df = df.filter(pl.col("bench_slug") == bench)
    if chain and chain != "All":
        df = df.filter(pl.col("chain") == chain)
    return (
        df.select(
            [
                pl.col("bench_slug").alias("Bench"),
                pl.col("chain").alias("Chain"),
                pl.col("leader_name").alias("Leader"),
                pl.col("leader_value").alias("Leader value"),
                pl.col("worst_name").alias("Worst"),
                pl.col("worst_value").alias("Worst value"),
            ]
        )
        .sort(["Bench", "Chain"])
        .to_pandas()
    )


def view_providers(bench: str) -> Any:
    df = providers_df()
    if not bench:
        return df.head(0).to_pandas()
    df = df.filter(pl.col("bench_slug") == bench)
    return (
        df.select(
            [
                pl.col("provider_name").alias("Provider"),
                pl.col("provider_type").alias("Type"),
                pl.col("p50").alias("p50"),
                pl.col("p90").alias("p90"),
                pl.col("p99").alias("p99"),
                pl.col("success_rate").alias("Success rate"),
                pl.col("provider_sample_size").alias("Sample size"),
                pl.col("is_leader").alias("Leader?"),
            ]
        )
        .sort("p50", nulls_last=True)
        .to_pandas()
    )


ABOUT_MD = f"""
## OpenChainBench

Public benchmarks for crypto infrastructure: RPCs, oracles, bridges, aggregators,
prediction markets, and more. The full leaderboard, methodology, and per-bench
detail live at [openchainbench.com]({SITE_URL}).

This Space is a thin viewer over the daily parquet snapshot published to
[{DATASET_REPO}]({DATASET_URL}). Every tab reads directly from the dataset, so
the numbers you see here match the dataset exactly.

### Links
- Website: [{SITE_URL}]({SITE_URL})
- Dataset: [{DATASET_URL}]({DATASET_URL})
- GitHub: [{GITHUB_URL}]({GITHUB_URL})

### License

The dataset is released under **CC-BY-4.0**. Attribution required: link
back to {SITE_URL} or the dataset page.

### Citation

```bibtex
@misc{{openchainbench2026,
  title  = {{OpenChainBench: Public benchmarks for crypto infrastructure}},
  author = {{OpenChainBench contributors}},
  year   = {{2026}},
  url    = {{{DATASET_URL}}},
  note   = {{CC-BY-4.0}}
}}
```
"""


def build_app() -> gr.Blocks:
    snapshot = latest_snapshot_date()
    title = f"OpenChainBench leaderboard ({snapshot})"

    with gr.Blocks(title=title, theme=gr.themes.Soft()) as demo:
        gr.Markdown(f"# {title}")
        gr.Markdown(
            "Sortable view of the daily snapshot. Click a bench title to open "
            f"its page on {SITE_URL}."
        )

        with gr.Tabs():
            with gr.Tab("Today's leaderboard"):
                cat = gr.Dropdown(
                    choices=_categories(),
                    value="All",
                    label="Category",
                )
                table = gr.Dataframe(
                    value=view_headlines("All"),
                    interactive=False,
                    wrap=True,
                    datatype=["markdown", "str", "str", "str", "str", "number", "number", "str"],
                )
                cat.change(view_headlines, inputs=cat, outputs=table)

            with gr.Tab("Per-chain leaders"):
                with gr.Row():
                    bench_dd = gr.Dropdown(
                        choices=_bench_choices_for_chains(),
                        value="All",
                        label="Bench",
                    )
                    chain_dd = gr.Dropdown(
                        choices=_chain_choices(),
                        value="All",
                        label="Chain",
                    )
                chains_table = gr.Dataframe(
                    value=view_chain_leaders("All", "All"),
                    interactive=False,
                    wrap=True,
                )
                bench_dd.change(
                    view_chain_leaders,
                    inputs=[bench_dd, chain_dd],
                    outputs=chains_table,
                )
                chain_dd.change(
                    view_chain_leaders,
                    inputs=[bench_dd, chain_dd],
                    outputs=chains_table,
                )

            with gr.Tab("Provider rankings"):
                slugs = _bench_slugs()
                default_slug = slugs[0] if slugs else None
                prov_dd = gr.Dropdown(
                    choices=slugs,
                    value=default_slug,
                    label="Bench slug",
                )
                prov_table = gr.Dataframe(
                    value=view_providers(default_slug) if default_slug else None,
                    interactive=False,
                    wrap=True,
                )
                prov_dd.change(view_providers, inputs=prov_dd, outputs=prov_table)

            with gr.Tab("About"):
                gr.Markdown(ABOUT_MD)

        gr.Markdown(f"---\n{FOOTER}")

    return demo


if __name__ == "__main__":
    app = build_app()
    app.launch(server_name="0.0.0.0", server_port=7860)
