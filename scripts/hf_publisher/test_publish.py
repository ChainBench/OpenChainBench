"""
Offline tests for the HF publisher.

These never hit the live API or HF Hub. They drive the row-builders +
quorum guard with hand-crafted payloads so a CI run can catch schema
regressions before they propagate to the public dataset.
"""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from publish import (
    PublisherError,
    SCHEMA_VERSION,
    Snapshot,
    build_chain_leaders,
    build_headlines,
    build_providers,
    build_timeseries,
    stage_static_assets,
    validate_quorum,
    write_partition,
)


def _snap(date: str = "2026-06-22") -> Snapshot:
    return Snapshot(date=date, captured_at=f"{date}T00:00:00+00:00")


def _citable_fixture(live_count: int = 20, total: int = 26) -> dict:
    benches = []
    for i in range(total):
        status = "live" if i < live_count else "insufficient"
        benches.append(
            {
                "slug": f"bench-{i}",
                "title": f"Bench {i}",
                "category": "RPCs",
                "metric": "Latency",
                "unit": "ms",
                "status": status,
                "value": 100.5 + i if status == "live" else None,
                "leader": (
                    {"name": "Mobula", "slug": "mobula", "value": 100.5 + i}
                    if status == "live"
                    else None
                ),
                "sampleSize": 1000 + i,
                "asOf": "2026-06-22T00:00:00.000Z",
                "url": f"https://openchainbench.com/benchmarks/bench-{i}",
                "api": f"https://openchainbench.com/api/stat/bench-{i}",
                "source": "https://github.com/ChainBench/OpenChainBench/blob/main/benchmarks/bench-0.yml",
                "license": "CC-BY-4.0",
            }
        )
    return {"count": total, "benchmarks": benches}


def _stat_fixture(slug: str = "bench-0", n_providers: int = 3, sparkline_len: int = 72) -> dict:
    return {
        "slug": slug,
        "higherIsBetter": False,
        "leader": {"name": "Mobula", "slug": "mobula"},
        "rankings": [
            {
                "name": f"Provider {i}",
                "slug": f"provider-{i}",
                "type": "aggregator" if i == 0 else "node-rpc",
                "layer": "L1" if i % 2 == 0 else "L2",
                "tag": "premium" if i == 0 else None,
                "ms": {
                    "p50": 100.0 + i,
                    "p90": 200.0 + i,
                    "p99": 500.0 + i,
                    "mean": 150.0 + i,
                },
                "successRate": 99.0 - i * 0.1,
                "sampleSize": 5000 - i * 100,
            }
            for i in range(n_providers)
        ],
        "sparkline": [100.0 + (j % 10) for j in range(sparkline_len)],
    }


def _series_fixture(
    slug: str = "bench-0",
    windows: tuple[str, ...] = ("24h", "7d", "30d"),
    n_providers: int = 2,
    points_per_window: dict[str, int] | None = None,
) -> dict[str, dict]:
    points_per_window = points_per_window or {"24h": 72, "7d": 84, "30d": 60}
    out: dict[str, dict] = {}
    for w in windows:
        n = points_per_window.get(w, 72)
        out[w] = {
            "slug": slug,
            "range": w,
            "providers": [
                {
                    "slug": f"provider-{i}",
                    "name": f"Provider {i}",
                    "values": [float(j + i) for j in range(n)],
                }
                for i in range(n_providers)
            ],
        }
    return out


class QuorumTests(unittest.TestCase):
    def test_passes_at_full_live(self):
        validate_quorum(_citable_fixture(live_count=26, total=26))

    def test_passes_at_half(self):
        validate_quorum(_citable_fixture(live_count=13, total=26))

    def test_refuses_below_half(self):
        with self.assertRaises(PublisherError):
            validate_quorum(_citable_fixture(live_count=12, total=26))

    def test_refuses_below_floor(self):
        with self.assertRaises(PublisherError):
            validate_quorum(_citable_fixture(live_count=7, total=20))

    def test_refuses_empty(self):
        with self.assertRaises(PublisherError):
            validate_quorum({"count": 0, "benchmarks": []})


class HeadlinesTests(unittest.TestCase):
    def test_columns_stable(self):
        df = build_headlines(_citable_fixture(), _snap())
        expected_cols = {
            "snapshot_date",
            "captured_at",
            "slug",
            "title",
            "category",
            "metric",
            "unit",
            "status",
            "value",
            "higher_is_better",
            "leader_name",
            "leader_slug",
            "leader_value",
            "bench_sample_size",
            "as_of",
            "citation_url",
            "stat_api_url",
            "source_url",
            "license",
            "schema_version",
        }
        self.assertEqual(set(df.columns), expected_cols)

    def test_schema_version_present(self):
        df = build_headlines(_citable_fixture(), _snap())
        self.assertTrue((df["schema_version"] == SCHEMA_VERSION).all())

    def test_insufficient_rows_have_null_value(self):
        df = build_headlines(_citable_fixture(live_count=10, total=12), _snap())
        live = df[df["status"] == "live"]
        insufficient = df[df["status"] == "insufficient"]
        self.assertTrue(live["value"].notna().all())
        self.assertTrue(insufficient["value"].isna().all())

    def test_higher_is_better_backfilled(self):
        df = build_headlines(
            _citable_fixture(live_count=2, total=2),
            _snap(),
            higher_is_better_by_slug={"bench-0": True, "bench-1": False},
        )
        by_slug = {r["slug"]: r["higher_is_better"] for _, r in df.iterrows()}
        self.assertEqual(by_slug["bench-0"], True)
        self.assertEqual(by_slug["bench-1"], False)

    def test_higher_is_better_null_when_missing(self):
        df = build_headlines(_citable_fixture(live_count=1, total=1), _snap())
        self.assertIsNone(df.iloc[0]["higher_is_better"])

    def test_bench_sample_size_renamed(self):
        df = build_headlines(_citable_fixture(), _snap())
        self.assertIn("bench_sample_size", df.columns)
        self.assertNotIn("sample_size", df.columns)


class ProvidersTests(unittest.TestCase):
    def test_one_row_per_provider(self):
        df = build_providers([_stat_fixture(n_providers=5)], _snap())
        self.assertEqual(len(df), 5)

    def test_leader_flag(self):
        df = build_providers([_stat_fixture(n_providers=3)], _snap())
        # Fixture leader is "mobula" but no provider has that slug, so 0 leaders.
        # Sanity: column exists and is boolean dtype.
        self.assertIn("is_leader", df.columns)

    def test_leader_flag_matches(self):
        stat = _stat_fixture(n_providers=3)
        stat["leader"] = {"name": "Provider 0", "slug": "provider-0"}
        df = build_providers([stat], _snap())
        self.assertEqual(df[df["is_leader"]]["provider_slug"].tolist(), ["provider-0"])

    def test_provider_classification_columns(self):
        df = build_providers([_stat_fixture(n_providers=3)], _snap())
        for col in ("provider_type", "provider_layer", "provider_tag"):
            self.assertIn(col, df.columns)
        # First provider has type=aggregator, tag=premium per fixture.
        row0 = df[df["provider_slug"] == "provider-0"].iloc[0]
        self.assertEqual(row0["provider_type"], "aggregator")
        self.assertEqual(row0["provider_tag"], "premium")

    def test_provider_sample_size_renamed(self):
        df = build_providers([_stat_fixture(n_providers=2)], _snap())
        self.assertIn("provider_sample_size", df.columns)
        self.assertNotIn("sample_size", df.columns)


class TimeseriesTests(unittest.TestCase):
    def test_one_row_per_point_per_provider_per_window(self):
        series = {"bench-0": _series_fixture(n_providers=2)}
        df = build_timeseries([_stat_fixture()], series, _snap())
        # 24h: 72 * 2, 7d: 84 * 2, 30d: 60 * 2 = 432
        self.assertEqual(len(df), (72 + 84 + 60) * 2)

    def test_windows_emitted(self):
        series = {"bench-0": _series_fixture(n_providers=1)}
        df = build_timeseries([_stat_fixture()], series, _snap())
        self.assertEqual(set(df["window"].unique()), {"24h", "7d", "30d"})

    def test_skips_nulls(self):
        series = {
            "bench-0": {
                "24h": {
                    "providers": [
                        {"slug": "p", "values": [1.0, None, 3.0, None, 5.0]}
                    ]
                }
            }
        }
        df = build_timeseries([_stat_fixture()], series, _snap())
        self.assertEqual(len(df), 3)

    def test_fallback_to_sparkline_when_no_series(self):
        # When /api/series returned no payloads, fall back to /api/stat sparkline
        # for the 24h window (legacy behaviour).
        df = build_timeseries([_stat_fixture(sparkline_len=72)], {"bench-0": {}}, _snap())
        only_24h = df[df["window"] == "24h"]
        self.assertEqual(len(only_24h), 72)

    def test_provider_slug_column_present(self):
        series = {"bench-0": _series_fixture(n_providers=1)}
        df = build_timeseries([_stat_fixture()], series, _snap())
        self.assertIn("provider_slug", df.columns)


class ChainLeadersTests(unittest.TestCase):
    def test_empty_with_canonical_columns(self):
        df = build_chain_leaders(_citable_fixture(), _snap())
        # Empty for now: spec API does not expose bestPerChain yet.
        self.assertEqual(len(df), 0)
        expected_cols = {
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
        }
        self.assertEqual(set(df.columns), expected_cols)


class PartitioningTests(unittest.TestCase):
    def test_write_partition_path_layout(self):
        df = build_headlines(_citable_fixture(), _snap())
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = write_partition(df, root, "headlines", _snap("2026-06-22"))
            self.assertTrue(path.exists())
            self.assertTrue(
                path.as_posix().endswith(
                    "headlines/snapshot_date=2026-06-22/part-0.parquet"
                ),
                msg=path.as_posix(),
            )

    def test_template_substitution(self):
        with TemporaryDirectory() as tmp:
            tmpl = Path(tmp) / "tmpl"
            tmpl.mkdir()
            (tmpl / "README.md").write_text("date={{snapshot_date}} v={{schema_version}}")
            out = Path(tmp) / "out"
            out.mkdir()
            stage_static_assets(out, tmpl, _snap("2026-06-22"))
            self.assertEqual(
                (out / "README.md").read_text(),
                f"date=2026-06-22 v={SCHEMA_VERSION}",
            )


class SchemaVersionTests(unittest.TestCase):
    def test_schema_version_is_v2(self):
        # Guard: bumping the schema is intentional, never accidental.
        self.assertEqual(SCHEMA_VERSION, 2)


if __name__ == "__main__":
    unittest.main()
