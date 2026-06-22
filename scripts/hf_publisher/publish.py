"""
Daily snapshot publisher for the Hugging Face dataset
`OpenChainBench/benchmarks`.

Reads the live citable JSON API plus per-bench detail, projects it into
four Hive-partitioned Parquet tables (headlines, providers, timeseries,
chain_leaders) keyed by snapshot_date, and pushes the new partitions to
the HF dataset repo.

Why multiple tables and not one wide table:
  headlines     1 row per (slug, date). Light. The "who leads" feed used
                by LLM agents and journalists. Cheap to scan.
  providers     1 row per (slug, provider, date). Detailed per-provider
                ranking with p50/p90/p99 plus type/layer/tag classification.
  timeseries    1 row per (slug, point_index, window, date) holding the
                24h / 7d / 30d trajectories. Separated so consumers can
                ignore it if they only want headlines.
  chain_leaders 1 row per (slug, chain, date) holding per-chain leader
                and worst provider, sourced from /api/stat's
                bestPerChain / worstPerChain fields. Empty for benches
                without a chain dimension (no chain-tagged Prom series).

Quorum guard: refuses to publish if /api/citable returns fewer than half
its declared count as live. The previous good snapshot stays as truth
on HF instead of being overwritten by a degraded one.

Schema versioning: each table embeds a `schema_version` int column.
Bump it when adding columns. Never remove columns. Never rename. The
HF dataset is a long-lived public artifact, downstream consumers will
write queries that assume column names are stable.

Idempotency: same snapshot_date overwrites itself. Re-running the cron
for a given day is safe.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
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
# Never decrement. Never re-use a version for a breaking change. If a
# breaking change is unavoidable, ship a parallel `headlines_v2/` folder
# while keeping the v1 partitions readable for old consumers.
#
# v1 (2026-06-22): initial release. 3 tables (headlines, providers,
#                  timeseries). `sample_size` ambiguously named.
# v2 (2026-06-22): adds `higher_is_better` to headlines, renames
#                  `sample_size` to `bench_sample_size` (headlines) and
#                  `provider_sample_size` (providers), adds
#                  `provider_type`, `provider_layer`, `provider_tag` to
#                  providers, extends timeseries with 7d / 30d windows
#                  and a `provider_slug` column, and adds the
#                  `chain_leaders` table (empty until bestPerChain is
#                  exposed via the public API).
SCHEMA_VERSION = 2

# Minimum count of live benches in /api/citable to allow publishing. The
# bench registry sits around 26, a snapshot with <50% live is considered
# degraded and refused. Floor of 8 avoids tripping during early-stage
# dev where the registry is intentionally small.
QUORUM_MIN_LIVE = 8
QUORUM_MIN_RATIO = 0.5

DEFAULT_API_BASE = "https://openchainbench.com"
DEFAULT_REPO_ID = "OpenChainBench/benchmarks"
USER_AGENT = "ocb-hf-publisher/2.0 (+https://openchainbench.com)"

# Kaggle mirror config. The dataset URL on Kaggle is
# https://www.kaggle.com/datasets/<owner>/<slug>. The owner is also the
# value of `KAGGLE_USERNAME` we authenticate with: the username has to
# be the dataset owner, otherwise the CLI returns 403 on create / version.
DEFAULT_KAGGLE_DATASET_ID = "openchainbench/benchmarks"
KAGGLE_METADATA_FILENAME = "dataset-metadata.json"

# Time-series windows fetched per bench. `/api/series/<slug>?range=<k>`
# returns one series per provider in the leaderboard at that range. We
# fold each provider's series into the parquet so consumers can compute
# trajectories without re-hitting the live API.
TIMESERIES_WINDOWS = ("24h", "7d", "30d")


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
    # socket-level read timeouts surface as bare TimeoutError on py3.10+
    # (subclass of OSError, not URLError). Catch explicitly so callers like
    # fetch_series can swallow per-URL timeouts via PublisherError instead
    # of aborting the whole snapshot.
    except TimeoutError as e:
        raise PublisherError(f"GET {url} timed out after {timeout}s") from e
    except OSError as e:
        raise PublisherError(f"GET {url} socket error: {e}") from e
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
    higher_is_better_by_slug: dict[str, bool] | None = None,
) -> pd.DataFrame:
    """Build the headlines table. The `higher_is_better_by_slug` map is
    sourced from the per-slug /api/stat fetches done by `run()`. /api/citable
    does not surface this field today, so we backfill from the stat
    payloads. Benches whose stat fetch failed get a null entry, which is
    intentional since we cannot interpret their leader without it.
    """
    higher_is_better_by_slug = higher_is_better_by_slug or {}
    rows: list[dict[str, Any]] = []
    for b in citable.get("benchmarks", []):
        leader = b.get("leader") or {}
        slug = b.get("slug")
        rows.append(
            {
                "snapshot_date": snap.date,
                "captured_at": snap.captured_at,
                "slug": slug,
                "title": b.get("title"),
                "category": b.get("category"),
                "metric": b.get("metric"),
                "unit": b.get("unit"),
                "status": b.get("status"),
                "value": _f(b.get("value")),
                "higher_is_better": higher_is_better_by_slug.get(slug),
                "leader_name": leader.get("name"),
                "leader_slug": leader.get("slug"),
                "leader_value": _f(leader.get("value")),
                "bench_sample_size": _f(b.get("sampleSize")),
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
                    "provider_type": r.get("type"),
                    "provider_layer": r.get("layer"),
                    "provider_tag": r.get("tag"),
                    "p50": _f(ms.get("p50")),
                    "p90": _f(ms.get("p90")),
                    "p99": _f(ms.get("p99")),
                    "mean": _f(ms.get("mean")),
                    "success_rate": _f(r.get("successRate")),
                    "provider_sample_size": _f(r.get("sampleSize")),
                    "is_leader": r.get("slug") == leader_slug,
                    "schema_version": SCHEMA_VERSION,
                }
            )
    return pd.DataFrame(rows)


def build_timeseries(
    stats: Iterable[dict[str, Any]],
    series_by_slug: dict[str, dict[str, dict[str, Any]]],
    snap: Snapshot,
) -> pd.DataFrame:
    """Build the timeseries table from /api/series payloads.

    `series_by_slug[slug][window]` is the JSON payload from
    /api/series/<slug>?range=<window>. The 24h window also falls back
    to the sparkline embedded in /api/stat when /api/series 404s, so
    timeseries stays populated for benches whose series endpoint has no
    data yet. The 7d / 30d windows have no such fallback. The bench
    silently emits zero rows for them if /api/series said no_data.
    """
    rows: list[dict[str, Any]] = []
    stats_by_slug = {s.get("slug"): s for s in stats if s.get("slug")}

    def _payload_has_data(payload: dict[str, Any] | None) -> bool:
        if not payload:
            return False
        for prov in payload.get("providers") or []:
            values = prov.get("values") or []
            if any(v is not None for v in values):
                return True
        return False

    for slug, by_window in series_by_slug.items():
        for window, payload in by_window.items():
            providers = payload.get("providers") or []
            for prov in providers:
                provider_slug = prov.get("slug")
                values = prov.get("values") or []
                for idx, value in enumerate(values):
                    if value is None:
                        continue
                    rows.append(
                        {
                            "snapshot_date": snap.date,
                            "captured_at": snap.captured_at,
                            "bench_slug": slug,
                            "provider_slug": provider_slug,
                            "point_index": idx,
                            "value": _f(value),
                            "window": window,
                            "schema_version": SCHEMA_VERSION,
                        }
                    )
        # Fallback for 24h: use the sparkline from /api/stat when
        # /api/series returned nothing or only empty providers for the
        # 24h range. Avoids losing historical 24h coverage on benches
        # whose /api/series endpoint hasn't been wired up yet.
        if not _payload_has_data(by_window.get("24h")):
            stat = stats_by_slug.get(slug) or {}
            spark = stat.get("sparkline") or []
            leader_slug = (stat.get("leader") or {}).get("slug")
            for idx, value in enumerate(spark):
                if value is None:
                    continue
                rows.append(
                    {
                        "snapshot_date": snap.date,
                        "captured_at": snap.captured_at,
                        "bench_slug": slug,
                        "provider_slug": leader_slug,
                        "point_index": idx,
                        "value": _f(value),
                        "window": "24h",
                        "schema_version": SCHEMA_VERSION,
                    }
                )
    return pd.DataFrame(rows)


def build_chain_leaders(
    stats: Iterable[dict[str, Any]],
    snap: Snapshot,
) -> pd.DataFrame:
    """Build the chain_leaders table. One row per (bench, chain) when
    the per-bench /api/stat response declares a `bestPerChain` (and
    optional `worstPerChain`) map. Benches without a chain dimension
    (no chain-tagged Prom labels) emit zero rows. Empty across the
    whole field is valid and surfaces as a zero-row parquet, so the
    schema, partitions, and downstream queries stay stable.
    """
    rows: list[dict[str, Any]] = []
    columns = [
        "snapshot_date",
        "captured_at",
        "bench_slug",
        "chain",
        "leader_name",
        "leader_slug",
        "leader_value",
        "worst_name",
        "worst_slug",
        "worst_value",
        "schema_version",
    ]
    for stat in stats:
        bench_slug = stat.get("slug")
        best = stat.get("bestPerChain") or {}
        worst = stat.get("worstPerChain") or {}
        if not isinstance(best, dict):
            continue
        for chain, leader in best.items():
            if not isinstance(leader, dict):
                continue
            worst_row = worst.get(chain) if isinstance(worst, dict) else None
            if not isinstance(worst_row, dict):
                worst_row = {}
            ms = leader.get("ms") or {}
            worst_ms = worst_row.get("ms") or {}
            rows.append(
                {
                    "snapshot_date": snap.date,
                    "captured_at": snap.captured_at,
                    "bench_slug": bench_slug,
                    "chain": chain,
                    "leader_name": leader.get("name"),
                    "leader_slug": leader.get("slug"),
                    "leader_value": _f(ms.get("p50")),
                    "worst_name": worst_row.get("name"),
                    "worst_slug": worst_row.get("slug"),
                    "worst_value": _f(worst_ms.get("p50")),
                    "schema_version": SCHEMA_VERSION,
                }
            )
    return pd.DataFrame(rows, columns=columns)


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


def build_kaggle_metadata(
    template_root: Path,
    snap: Snapshot,
    dataset_id: str = DEFAULT_KAGGLE_DATASET_ID,
) -> dict[str, Any]:
    """Load `dataset-metadata.json` from the template folder, substitute
    placeholders (`{{snapshot_date}}`, `{{captured_at}}`,
    `{{schema_version}}`), and override the `id` field with `dataset_id`.

    The shape returned matches what the Kaggle CLI expects:
    https://github.com/Kaggle/kaggle-api/blob/main/docs/dataset-metadata.json
    """
    src = template_root / KAGGLE_METADATA_FILENAME
    if not src.is_file():
        raise PublisherError(
            f"kaggle metadata template missing at {src}"
        )
    text = src.read_text(encoding="utf-8")
    text = (
        text.replace("{{snapshot_date}}", snap.date)
        .replace("{{captured_at}}", snap.captured_at)
        .replace("{{schema_version}}", str(SCHEMA_VERSION))
    )
    try:
        meta = json.loads(text)
    except json.JSONDecodeError as e:
        raise PublisherError(f"kaggle metadata is not valid JSON: {e}") from e

    if not isinstance(meta, dict):
        raise PublisherError("kaggle metadata must be a JSON object")
    if "/" not in dataset_id:
        raise PublisherError(
            f"kaggle dataset id must be <owner>/<slug>, got {dataset_id!r}"
        )
    meta["id"] = dataset_id
    # Kaggle requires `licenses` to be a non-empty list of objects with a
    # `name` field. Guard the template against accidental edits.
    licenses = meta.get("licenses") or []
    if not isinstance(licenses, list) or not licenses:
        raise PublisherError("kaggle metadata missing `licenses`")
    # Kaggle enforces a 20-80 char subtitle. Surfacing the constraint here
    # turns a remote API 400 into a local PublisherError with a precise
    # location, which the next contributor can fix without hunting through
    # the kaggle CLI output.
    subtitle = meta.get("subtitle") or ""
    if not isinstance(subtitle, str) or not 20 <= len(subtitle) <= 80:
        raise PublisherError(
            f"kaggle subtitle must be 20 to 80 chars, got {len(subtitle)}"
        )
    return meta


def _run_kaggle(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    """Run the kaggle CLI and return the completed process. Capturing
    stdout / stderr so we can branch on the error string for the first-push
    case without spamming the GH Action log on the happy path."""
    return subprocess.run(
        ["kaggle", *args],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        check=False,
    )


def push_to_kaggle(
    out_root: Path,
    template_root: Path,
    snap: Snapshot,
    dataset_id: str,
    commit_message: str,
) -> str:
    """Mirror the staged parquet folder to Kaggle.

    Writes a fresh `dataset-metadata.json` into `out_root`, then runs
    `kaggle datasets version`. If the dataset does not exist yet on
    Kaggle, the CLI returns a 404-ish error and we fall back to
    `kaggle datasets create`. Returns the URL the dataset lands on.

    Errors here MUST never propagate: HF is the canonical sink, Kaggle is
    a best-effort mirror. The caller wraps this in try/except.
    """
    if not out_root.is_dir():
        raise PublisherError(f"kaggle staging dir missing: {out_root}")

    meta = build_kaggle_metadata(template_root, snap, dataset_id)
    (out_root / KAGGLE_METADATA_FILENAME).write_text(
        json.dumps(meta, indent=2) + "\n",
        encoding="utf-8",
    )

    # `--dir-mode zip` packs the Hive partition folders into the upload
    # archive so the layout is preserved on Kaggle's side. Without it the
    # CLI would only upload files at the top level of out_root.
    version = _run_kaggle(
        [
            "datasets",
            "version",
            "-p",
            str(out_root),
            "-m",
            commit_message,
            "--dir-mode",
            "zip",
        ]
    )
    if version.returncode == 0:
        logger.info("kaggle: pushed new version of %s", dataset_id)
    else:
        # The CLI emits "Dataset not found" / 404 when the dataset has
        # never been created. In that case we bootstrap with `create`.
        # Any other failure is propagated.
        stderr = (version.stderr or "") + (version.stdout or "")
        looks_missing = (
            "404" in stderr
            or "not found" in stderr.lower()
            or "does not exist" in stderr.lower()
        )
        if not looks_missing:
            raise PublisherError(
                f"kaggle version failed (code={version.returncode}): {stderr.strip()}"
            )
        logger.info("kaggle: dataset %s missing, creating", dataset_id)
        create = _run_kaggle(
            [
                "datasets",
                "create",
                "-p",
                str(out_root),
                "-u",
                "--dir-mode",
                "zip",
            ]
        )
        if create.returncode != 0:
            stderr = (create.stderr or "") + (create.stdout or "")
            raise PublisherError(
                f"kaggle create failed (code={create.returncode}): {stderr.strip()}"
            )
        logger.info("kaggle: created %s", dataset_id)

    return f"https://www.kaggle.com/datasets/{dataset_id}"


def stage_static_assets(out_root: Path, template_root: Path, snap: Snapshot) -> None:
    """Copy README.md + CITATION.cff + LICENSE + schemas + examples into
    the upload folder. Templates may include `{{date}}` placeholders.

    `dataset-metadata.json` is deliberately skipped: it is a Kaggle-only
    artifact and would just add noise to the HF repo if committed. It is
    written into the staging folder later by `push_to_kaggle`.
    """
    import shutil

    if not template_root.is_dir():
        return
    for src in template_root.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(template_root)
        if rel.name == KAGGLE_METADATA_FILENAME:
            continue
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


def fetch_series(api_base: str, slug: str) -> dict[str, dict[str, Any]]:
    """Fetch /api/series/<slug>?range=<w> for every supported window.
    Returns a dict {window: payload}. Windows that 404, time out, or hit a
    socket error are skipped silently so one slow bench cannot abort the
    whole snapshot. The 30d window is the most likely to time out on a
    cold cache."""
    out: dict[str, dict[str, Any]] = {}
    for window in TIMESERIES_WINDOWS:
        url = f"{api_base}/api/series/{slug}?range={window}"
        try:
            out[window] = fetch_json(url, timeout=60.0)
        except PublisherError as e:
            logger.info("skip series %s @ %s: %s", slug, window, e)
    return out


def run(
    api_base: str,
    repo_id: str,
    token: str | None,
    out_root: Path,
    template_root: Path,
    dry_run: bool,
    slack_webhook: str | None,
    kaggle_dataset_id: str = DEFAULT_KAGGLE_DATASET_ID,
    kaggle_username: str | None = None,
    kaggle_key: str | None = None,
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
    series_by_slug: dict[str, dict[str, dict[str, Any]]] = {}
    for slug in live_slugs:
        try:
            stats.append(fetch_json(f"{api_base}/api/stat/{slug}"))
        except PublisherError as e:
            # One bad per-slug fetch shouldn't abort the run. Log and skip.
            logger.warning("skip per-slug fetch for %s: %s", slug, e)
            continue
        series_by_slug[slug] = fetch_series(api_base, slug)

    # /api/citable does not surface higherIsBetter today, /api/stat does.
    # We backfill from the per-slug payloads so headlines carries the
    # field. Slugs whose stat fetch failed get a null entry.
    higher_is_better_by_slug: dict[str, bool] = {
        slug: bool(s.get("higherIsBetter"))
        for s in stats
        if (slug := s.get("slug")) and "higherIsBetter" in s
    }

    headlines = build_headlines(citable, snap, higher_is_better_by_slug)
    providers = build_providers(stats, snap)
    timeseries = build_timeseries(stats, series_by_slug, snap)
    chain_leaders = build_chain_leaders(stats, snap)

    if headlines.empty:
        raise PublisherError("empty headlines table, refusing to publish")

    write_partition(headlines, out_root, "headlines", snap)
    write_partition(providers, out_root, "providers", snap)
    write_partition(timeseries, out_root, "timeseries", snap)
    write_partition(chain_leaders, out_root, "chain_leaders", snap)
    stage_static_assets(out_root, template_root, snap)

    if dry_run:
        logger.info("dry-run: skipping HF push, files staged at %s", out_root)
        if kaggle_username and kaggle_key:
            logger.info(
                "dry-run: skipping kaggle mirror (would push to %s)",
                kaggle_dataset_id,
            )
        else:
            logger.info("kaggle skip: secrets not set")
        return

    if not token:
        raise PublisherError("HF_TOKEN missing in non-dry-run mode")

    commit_message = (
        f"snapshot {snap.date} "
        f"(rows: h={len(headlines)} p={len(providers)} "
        f"ts={len(timeseries)} cl={len(chain_leaders)})"
    )
    oid = push_to_hf(out_root, repo_id, token, commit_message)
    logger.info("pushed to HF: %s commit=%s", repo_id, oid)
    post_slack(
        slack_webhook,
        f":white_check_mark: OCB HF snapshot {snap.date} published "
        f"(h={len(headlines)}, p={len(providers)}, "
        f"ts={len(timeseries)}, cl={len(chain_leaders)}) "
        f"https://huggingface.co/datasets/{repo_id}/tree/main",
    )

    # Best-effort Kaggle mirror. HF is the canonical sink; a Kaggle
    # failure must not abort the run nor mark the HF push as failed.
    if not (kaggle_username and kaggle_key):
        logger.info("kaggle skip: secrets not set")
        return

    # The kaggle CLI reads `KAGGLE_USERNAME` / `KAGGLE_KEY` from the
    # process env, so forwarding them in os.environ is sufficient. We
    # only ensure they are visible to the subprocess.
    os.environ["KAGGLE_USERNAME"] = kaggle_username
    os.environ["KAGGLE_KEY"] = kaggle_key
    try:
        kaggle_url = push_to_kaggle(
            out_root=out_root,
            template_root=template_root,
            snap=snap,
            dataset_id=kaggle_dataset_id,
            commit_message=commit_message,
        )
        logger.info("kaggle mirror ok: %s", kaggle_url)
    except Exception as e:
        logger.warning("kaggle mirror failed: %s", e)
        post_slack(
            slack_webhook,
            f":warning: OCB Kaggle mirror failed for snapshot {snap.date} "
            f"(HF push succeeded): {e}",
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
        "--kaggle-dataset-id",
        default=os.environ.get("KAGGLE_DATASET_ID", DEFAULT_KAGGLE_DATASET_ID),
        help="Kaggle dataset id in <owner>/<slug> form. The owner must match KAGGLE_USERNAME.",
    )
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
    kaggle_username = os.environ.get("KAGGLE_USERNAME")
    kaggle_key = os.environ.get("KAGGLE_KEY")
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
            kaggle_dataset_id=args.kaggle_dataset_id,
            kaggle_username=kaggle_username,
            kaggle_key=kaggle_key,
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
