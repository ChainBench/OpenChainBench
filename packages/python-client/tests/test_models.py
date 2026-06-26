"""Unit tests for the dataclass parsers.

The fixtures under ``tests/fixtures/`` are hand-crafted minimal payloads
that mirror the public API shape. They are intentionally small so the
tests stay fast and so a shape change in the API forces a deliberate
fixture update.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openchainbench.models import (
    Benchmark,
    CitableIndex,
    Series,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_citable_index_parses() -> None:
    index = CitableIndex.from_dict(_load("citable.json"))
    assert index.site_name == "OpenChainBench"
    assert index.site_url == "https://openchainbench.com"
    assert index.count == 2
    assert len(index.benchmarks) == 2

    live = index.benchmarks[0]
    assert live.slug == "bridge-fee"
    assert live.status == "live"
    assert live.leader is not None
    assert live.leader.slug == "near-intents"
    assert live.value == pytest.approx(0.00916)
    assert live.source is not None
    assert live.source.type == "harness"
    assert live.license == "CC-BY-4.0"

    insufficient = index.benchmarks[1]
    assert insufficient.status == "insufficient"
    assert insufficient.value is None
    assert insufficient.leader is None
    assert insufficient.source is None


def test_benchmark_parses() -> None:
    bench = Benchmark.from_dict(_load("stat.json"))
    assert bench.slug == "bridge-fee"
    assert bench.higher_is_better is False
    assert bench.value == pytest.approx(0.00916)
    assert bench.leader is not None
    assert bench.leader.name == "Near Intents"
    assert len(bench.rankings) == 2

    top = bench.rankings[0]
    assert top.slug == "near-intents"
    assert top.ms.p50 == pytest.approx(0.00916)
    assert top.ms.p99 == pytest.approx(0.011)
    assert top.sample_size == 11520
    assert top.success_rate == pytest.approx(89.06)

    assert len(bench.sparkline) == 4
    assert bench.methodology
    assert any("USDC" in line for line in bench.methodology)


def test_series_parses() -> None:
    series = Series.from_dict(_load("series.json"))
    assert series.slug == "bridge-fee"
    assert series.range == "24h"
    assert len(series.timestamps) == 4
    assert len(series.providers) == 2

    mobula = series.providers[0]
    assert mobula.slug == "mobula"
    assert mobula.logo and mobula.logo.startswith("https://")
    assert len(mobula.values) == len(series.timestamps)

    near = series.providers[1]
    assert near.logo is None
    assert near.color == "#000000"


def test_benchmark_handles_insufficient_payload() -> None:
    payload = {
        "slug": "metadata-coverage",
        "title": "Token metadata coverage",
        "subtitle": None,
        "category": "Data",
        "metric": "Coverage",
        "unit": "pct",
        "status": "insufficient",
        "higherIsBetter": True,
        "value": None,
        "leader": None,
        "rankings": [
            {
                "name": "Provider A",
                "slug": "provider-a",
                "type": None,
                "layer": None,
                "tag": None,
                "ms": {"p50": None, "p90": None, "p99": None, "mean": None},
                "successRate": None,
                "sampleSize": None,
            }
        ],
        "sparkline": [],
        "sampleSize": 0,
        "asOf": None,
        "headline": "Insufficient sample.",
        "quote": None,
        "pageUrl": "https://openchainbench.com/benchmarks/metadata-coverage",
        "ogImage": None,
        "source": None,
        "methodology": None,
        "license": "CC-BY-4.0",
        "bestPerChain": None,
        "worstPerChain": None,
    }
    bench = Benchmark.from_dict(payload)
    assert bench.value is None
    assert bench.leader is None
    assert bench.sparkline == ()
    assert bench.rankings[0].ms.p50 is None
    assert bench.rankings[0].sample_size is None
