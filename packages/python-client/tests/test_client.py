"""Client tests.

The ``test_client_*`` cases mock the HTTP layer so they run offline.
The ``test_integration_*`` cases hit the live openchainbench.com API and
are skipped when the ``OCB_SKIP_INTEGRATION`` environment variable is set
(use this for offline CI or air-gapped builds).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest

from openchainbench import (
    APIUnavailableError,
    Benchmark,
    BenchmarkSummary,
    NotFoundError,
    OpenChainBench,
    OpenChainBenchError,
    RateLimitError,
    Series,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _client_with_handler(handler):
    transport = httpx.MockTransport(handler)
    inner = httpx.Client(
        base_url="https://example.test",
        transport=transport,
        headers={"User-Agent": "openchainbench-python/test"},
    )
    return OpenChainBench(client=inner)


def test_list_benchmarks_returns_typed_summaries() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/citable"
        return httpx.Response(200, json=_fixture("citable.json"))

    with _client_with_handler(handler) as ocb:
        rows = ocb.list_benchmarks()
        assert len(rows) == 2
        assert all(isinstance(r, BenchmarkSummary) for r in rows)
        assert rows[0].slug == "bridge-fee"


def test_get_benchmark_forwards_filters() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json=_fixture("stat.json"))

    with _client_with_handler(handler) as ocb:
        bench = ocb.get_benchmark("bridge-fee", chain="ethereum", region="eu-west")

    assert isinstance(bench, Benchmark)
    assert captured["path"] == "/api/stat/bridge-fee"
    assert captured["params"] == {"chain": "ethereum", "region": "eu-west"}


def test_get_series_validates_range() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_fixture("series.json"))

    with _client_with_handler(handler) as ocb:
        with pytest.raises(ValueError):
            ocb.get_series("bridge-fee", range="bogus")


def test_get_series_forwards_provider_filter() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json=_fixture("series.json"))

    with _client_with_handler(handler) as ocb:
        series = ocb.get_series(
            "bridge-fee", range="24h", providers=["mobula", "near-intents"]
        )

    assert isinstance(series, Series)
    assert captured["params"]["range"] == "24h"
    assert captured["params"]["providers"] == "mobula,near-intents"


def test_not_found_raises_typed_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "unknown_slug", "slug": "nope"})

    with _client_with_handler(handler) as ocb:
        with pytest.raises(NotFoundError):
            ocb.get_benchmark("nope")


def test_rate_limit_surfaces_retry_after() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"error": "rate_limited", "retryAfterSec": 42},
            headers={"retry-after": "42"},
        )

    with _client_with_handler(handler) as ocb:
        with pytest.raises(RateLimitError) as exc:
            ocb.list_benchmarks()
        assert exc.value.retry_after_sec == 42


def test_unavailable_503_raises_typed_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            json={"error": "benchmarks_unavailable", "retryAfterSec": 60},
            headers={"retry-after": "60"},
        )

    with _client_with_handler(handler) as ocb:
        with pytest.raises(APIUnavailableError) as exc:
            ocb.list_benchmarks()
        assert exc.value.retry_after_sec == 60


def test_generic_5xx_raises_base_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    with _client_with_handler(handler) as ocb:
        with pytest.raises(OpenChainBenchError) as exc:
            ocb.list_benchmarks()
        assert exc.value.status_code == 500


_SKIP_INTEGRATION = os.environ.get("OCB_SKIP_INTEGRATION") == "1"


@pytest.mark.integration
@pytest.mark.skipif(_SKIP_INTEGRATION, reason="OCB_SKIP_INTEGRATION=1")
def test_integration_list_benchmarks() -> None:
    with OpenChainBench() as ocb:
        index = ocb.fetch_citable_index()
        assert index.site_url == "https://openchainbench.com"
        assert index.license == "CC-BY-4.0"
        # count may be 0 on a cold cache (503 is also acceptable, see next test).
        assert index.count >= 0


@pytest.mark.integration
@pytest.mark.skipif(_SKIP_INTEGRATION, reason="OCB_SKIP_INTEGRATION=1")
def test_integration_get_benchmark_known_slug() -> None:
    with OpenChainBench() as ocb:
        try:
            bench = ocb.get_benchmark("bridge-fee")
        except (NotFoundError, APIUnavailableError) as exc:
            pytest.skip(f"upstream not serving bridge-fee right now: {exc}")
        assert bench.slug == "bridge-fee"
        assert bench.license == "CC-BY-4.0"
        assert bench.unit  # non-empty


@pytest.mark.integration
@pytest.mark.skipif(_SKIP_INTEGRATION, reason="OCB_SKIP_INTEGRATION=1")
def test_integration_get_series_known_slug() -> None:
    with OpenChainBench() as ocb:
        try:
            series = ocb.get_series("bridge-fee", range="24h")
        except (NotFoundError, APIUnavailableError) as exc:
            pytest.skip(f"upstream not serving bridge-fee series: {exc}")
        assert series.range == "24h"
        assert len(series.timestamps) > 0
        assert len(series.providers) > 0
