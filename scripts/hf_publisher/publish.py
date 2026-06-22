"""
Daily snapshot publisher for the Hugging Face dataset
`OpenChainBench/benchmarks`.

Reads the live citable JSON API plus per-bench detail, projects it into
three Hive-partitioned Parquet tables (headlines, providers, timeseries)
keyed by snapshot_date, and pushes the new partitions to the HF dataset
repo.

Why three tables and not one wide table:
  headlines  - 1 row per (slug, date). Light. The "who leads" feed used
               by LLM agents and journalists. Cheap to scan.
  providers  - 1 row per (slug, provider, date). Detailed per-provider
               ranking with p50/p90/p99. Used by devs comparing options.
  timeseries - 1 row per (slug, point_index, date) holding the 24h
               sparkline. Useful for analytical workloads. Separated so
               consumers can ignore it if they only want headlines.

Quorum guard: refuses to publish if /api/citable returns fewer than half
its declared count as live. The previous good snapshot stays as truth
on HF instead of being overwritten by a degraded one.

Schema versioning: each table embeds a `schema_version` int column.
Bump it when adding columns. Never remove columns. Never rename. The
HF dataset is a long-lived public artifact - downstream consumers will
write queries that assume column names are stable.

Idempotency: same snapshot_date overwrites itself. Re-running the cron
for a given day is safe.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

logger = logging.getLogger("hf_publisher")

# Bump together with any additive schema change in the row builders below.
# Never decrement. Never re-use a version for a breaking change - if a
# breaking change is unavoidable, ship a parallel `headlines_v2/` folder
# while keeping the v1 partitions readable for old consumers.
SCHEMA_VERSION = 1

# Minimum count of live benches in /api/citable to allow publishing. The
# bench registry sits around 26; a snapshot with <50% live is considered
# degraded and refused. Floor of 8 avoids tripping during early-stage
# dev where the registry is intentionally small.
QUORUM_MIN_LIVE = 8
QUORUM_MIN_RATIO = 0.5

DEFAULT_API_BASE = "https://openchainbench.com"
DEFAULT_REPO_ID = "OpenChainBench/benchmarks"
USER_AGENT = "ocb-hf-publisher/1.0 (+https://openchainbench.com)"


class PublisherError(Exception):
    """Raised when the snapshot is unfit to publish."""


@dataclass(frozen=True)
class Snapshot:
    date: str  # ISO date, partition key value
    captured_at: str  # ISO timestamp UTC, embedded in every row


def fetch_json(url: str, timeout: float = 30.0) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise PublisherError(f"GET {url} returned HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise PublisherError(f"GET {url} failed: {e.reason}") from e
    try:
        return json.loads(payload)
    except json.JSONDecodeError as e:
        raise PublisherError(f"GET {url} returned non-JSON body") from e


def validate_quorum(citable: dict[str, Any]) -> None:
    count = int(citable.get("count") or 0)
    benches = citable.get("benchmarks") or []
    live = sum(1 for b in benches if b.get("status") == "live")
    if count < QUORUM_MIN_LIVE:
        raise PublisherError(
            f"degraded source: count={count} below minimum {QUORUM_MIN_LIVE}"
        )
    if live < QUORUM_MIN_LIVE or live / max(count, 1) < QUORUM_MIN_RATIO:
        raise PublisherError(
            f"degraded source: only {live}/{count} live (<{QUORUM_MIN_RATIO:.0%})"
        )
    logger.info("quorum ok: %d/%d live", live, count)


def build_headlines(
    citable: dict[str, Any],
    snap: Snapshot,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for b in citable.get("benchmarks", []):
        leader = b.get("leader") or {}
        rows.append(
            {
                "snapshot_date": snap.date,
                "captured_at": snap.captured_at,
                "slug": b.get("slug"),
                "title": b.get("title"),
                "category": b.get("category"),
                "metric": b.get("metric"),
                "unit": b.get("unit"),
                "status": b.get("status"),
                "value": _f(b.get("value")),
                "leader_name": leader.get("name"),
                "leader_slug": leader.get("slug"),
                "leader_value": _f(leader.get("value")),
                "sample_size": _f(b.get("sampleSize")),
                "as_of": b.get("asOf"),
                "citation_url": b.get("url"),
                "stat_api_url": b.get("api"),
                "source_url": b.get("source"),
                "license": b.get("license"),
                "schema_version": SCHEMA_VERSION,
            }
        )
    return pd.DataFrame(rows)


def build_providers(
    stats: Iterable[dict[str, Any]],
    snap: Snapshot,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for stat in stats:
        slug = stat.get("slug")
        leader_slug = (stat.get("leader") or {}).get("slug")
        for r in stat.get("rankings") or []:
            ms = r.get("ms") or {}
            rows.append(
                {
                    "snapshot_date": snap.date,
                    "captured_at": snap.captured_at,
                    "bench_slug": slug,
                    "provider_name": r.get("name"),
                    "provider_slug": r.get("slug"),
                    "p50": _f(ms.get("p50")),
                    "p90": _f(ms.get("p90")),
                    "p99": _f(ms.get("p99")),
                    "mean": _f(ms.get("mean")),
                    "success_rate": _f(r.get("successRate")),
                    "sample_size": _f(r.get("sampleSize")),
                    "is_leader": r.get("slug") == leader_slug,
                    "schema_version": SCHEMA_VERSION,
                }
            )
    return pd.DataFrame(rows)


def build_timeseries(
    stats: Iterable[dict[str, Any]],
    snap: Snapshot,
) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for stat in stats:
        slug = stat.get("slug")
        spark = stat.get("sparkline") or []
        for idx, value in enumerate(spark):
            if value is None:
                continue
            rows.append(
                {
                    "snapshot_date": snap.date,
                    "captured_at": snap.captured_at,
                    "bench_slug": slug,
                    "point_index": idx,
                    "value": _f(value),
                    "window": "24h",
                    "schema_version": SCHEMA_VERSION,
                }
            )
    return pd.DataFrame(rows)


def _f(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def write_partition(df: pd.DataFrame, root: Path, table: str, snap: Snapshot) -> Path:
    """Write a single Hive partition: <root>/<table>/snapshot_date=<date>/part-0.parquet.

    Snappy + ZSTD: Snappy is wider compatible (most readers default),
    ZSTD compresses better. We use ZSTD because Polars/DuckDB/PyArrow
    all read it natively now and the size delta matters at scale.
    """
    target_dir = root / table / f"snapshot_date={snap.date}"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "part-0.parquet"
    table_ar = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table_ar, target, compression="zstd")
    logger.info("wrote %s rows=%d size=%dKB", target, len(df), target.stat().st_size // 1024)
    return target


def post_slack(webhook: str | None, text: str) -> None:
    if not webhook:
        return
    data = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        webhook,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except Exception as e:
        # Slack failure must not mask the underlying error
        logger.warning("slack notify failed: %s", e)


def push_to_hf(
    out_root: Path,
    repo_id: str,
    token: str,
    commit_message: str,
) -> str:
    """Push the staged dataset folder to HF Hub. Creates the repo if it
    doesn't exist. Returns the commit hash."""
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    api.create_repo(
        repo_id=repo_id,
        repo_type="dataset",
        exist_ok=True,
        private=False,
    )
    # upload_folder commits everything below `folder_path` keeping the
    # relative paths. Hive partitions therefore land at the right place.
    info = api.upload_folder(
        folder_path=str(out_root),
        repo_id=repo_id,
        repo_type="dataset",
        commit_message=commit_message,
    )
    return info.oid if hasattr(info, "oid") else "unknown"


def stage_static_assets(out_root: Path, template_root: Path, snap: Snapshot) -> None:
    """Copy README.md + CITATION.cff + LICENSE + schemas + examples into
    the upload folder. Templates may include `{{date}}` placeholders."""
    import shutil

    if not template_root.is_dir():
        return
    for src in template_root.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(template_root)
        dst = out_root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix in {".md", ".cff", ".json", ".py", ".sql"}:
            text = src.read_text(encoding="utf-8")
            text = (
                text.replace("{{snapshot_date}}", snap.date)
                .replace("{{captured_at}}", snap.captured_at)
                .replace("{{schema_version}}", str(SCHEMA_VERSION))
            )
            dst.write_text(text, encoding="utf-8")
        else:
            shutil.copy2(src, dst)


def run(
    api_base: str,
    repo_id: str,
    token: str | None,
    out_root: Path,
    template_root: Path,
    dry_run: bool,
    slack_webhook: str | None,
) -> None:
    snap = Snapshot(
        date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        captured_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    logger.info("publishing snapshot %s", snap.date)

    citable = fetch_json(f"{api_base}/api/citable")
    validate_quorum(citable)

    live_slugs = [
        b["slug"]
        for b in citable.get("benchmarks", [])
        if b.get("status") == "live" and b.get("slug")
    ]
    stats: list[dict[str, Any]] = []
    for slug in live_slugs:
        try:
            stats.append(fetch_json(f"{api_base}/api/stat/{slug}"))
        except PublisherError as e:
            # One bad per-slug fetch shouldn't abort the run. Log and skip.
            logger.warning("skip per-slug fetch for %s: %s", slug, e)

    headlines = build_headlines(citable, snap)
    providers = build_providers(stats, snap)
    timeseries = build_timeseries(stats, snap)

    if headlines.empty:
        raise PublisherError("empty headlines table - refusing to publish")

    write_partition(headlines, out_root, "headlines", snap)
    write_partition(providers, out_root, "providers", snap)
    write_partition(timeseries, out_root, "timeseries", snap)
    stage_static_assets(out_root, template_root, snap)

    if dry_run:
        logger.info("dry-run: skipping HF push, files staged at %s", out_root)
        return

    if not token:
        raise PublisherError("HF_TOKEN missing in non-dry-run mode")

    commit_message = f"snapshot {snap.date} (rows: h={len(headlines)} p={len(providers)} ts={len(timeseries)})"
    oid = push_to_hf(out_root, repo_id, token, commit_message)
    logger.info("pushed to HF: %s commit=%s", repo_id, oid)
    post_slack(
        slack_webhook,
        f":white_check_mark: OCB HF snapshot {snap.date} published "
        f"(h={len(headlines)}, p={len(providers)}, ts={len(timeseries)}) "
        f"https://huggingface.co/datasets/{repo_id}/tree/main",
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--api-base", default=os.environ.get("OCB_API", DEFAULT_API_BASE))
    p.add_argument("--repo-id", default=os.environ.get("HF_REPO_ID", DEFAULT_REPO_ID))
    p.add_argument("--out", default=os.environ.get("OCB_OUT", "/tmp/ocb-hf-staging"))
    p.add_argument(
        "--template",
        default=str(Path(__file__).parent / "dataset_template"),
        help="Static files copied into the dataset (README, CITATION, schemas, examples).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip HF push. Use for local + CI checks.",
    )
    args = p.parse_args()

    token = os.environ.get("HF_TOKEN")
    slack = os.environ.get("SLACK_WEBHOOK_URL")
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    try:
        run(
            api_base=args.api_base,
            repo_id=args.repo_id,
            token=token,
            out_root=out_root,
            template_root=Path(args.template),
            dry_run=args.dry_run,
            slack_webhook=slack,
        )
        return 0
    except PublisherError as e:
        logger.error("publisher aborted: %s", e)
        post_slack(slack, f":x: OCB HF publisher aborted: {e}")
        return 2
    except Exception as e:
        logger.exception("publisher crashed: %s", e)
        post_slack(slack, f":fire: OCB HF publisher crashed: {e}")
        return 3


if __name__ == "__main__":
    sys.exit(main())
