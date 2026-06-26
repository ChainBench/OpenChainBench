"""Synchronous HTTP client for the public OpenChainBench API.

Wraps three endpoints:

* ``GET /api/citable`` -> :meth:`OpenChainBench.list_benchmarks`
* ``GET /api/stat/<slug>`` -> :meth:`OpenChainBench.get_benchmark`
* ``GET /api/series/<slug>?range=...`` -> :meth:`OpenChainBench.get_series`

The client keeps a long-lived ``httpx.Client`` and supports the context
manager protocol. Errors are mapped to a typed hierarchy in
:mod:`openchainbench.exceptions` so callers can ``except`` on intent rather
than HTTP status codes.
"""

from __future__ import annotations

from typing import Any, List, Optional

import httpx

from .exceptions import (
    APIUnavailableError,
    NotFoundError,
    OpenChainBenchError,
    RateLimitError,
)
from .models import Benchmark, BenchmarkSummary, CitableIndex, Series

DEFAULT_BASE_URL = "https://openchainbench.com"
DEFAULT_TIMEOUT = 30.0
USER_AGENT = "openchainbench-python/0.1.0"

_SUPPORTED_RANGES = ("24h", "7d", "30d")


def _parse_retry_after(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code < 400:
        return

    body: Any
    try:
        body = response.json()
    except ValueError:
        body = {}

    message = (
        body.get("error")
        if isinstance(body, dict) and body.get("error")
        else f"HTTP {response.status_code} from {response.request.url}"
    )

    if response.status_code == 404:
        raise NotFoundError(str(message))
    if response.status_code == 429:
        retry = _parse_retry_after(response.headers.get("retry-after"))
        if retry is None and isinstance(body, dict):
            retry = body.get("retryAfterSec")
        raise RateLimitError(str(message), retry_after_sec=retry)
    if response.status_code == 503:
        retry = _parse_retry_after(response.headers.get("retry-after"))
        if retry is None and isinstance(body, dict):
            retry = body.get("retryAfterSec")
        raise APIUnavailableError(str(message), retry_after_sec=retry)

    raise OpenChainBenchError(str(message), status_code=response.status_code)


class OpenChainBench:
    """Synchronous client for openchainbench.com.

    Example:
        >>> from openchainbench import OpenChainBench
        >>> with OpenChainBench() as ocb:
        ...     for bench in ocb.list_benchmarks():
        ...         print(bench.slug, bench.value)
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        user_agent: str = USER_AGENT,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={
                "User-Agent": user_agent,
                "Accept": "application/json",
            },
        )

    def list_benchmarks(self) -> List[BenchmarkSummary]:
        """Return every live benchmark with its current headline figure.

        Wraps the ``CitableIndex`` envelope and returns the list directly
        for ergonomic iteration. Use :meth:`fetch_citable_index` if you
        need the site metadata as well.
        """
        return list(self.fetch_citable_index().benchmarks)

    def fetch_citable_index(self) -> CitableIndex:
        """Return the full ``/api/citable`` payload including site metadata."""
        data = self._get("/api/citable")
        return CitableIndex.from_dict(data)

    def get_benchmark(
        self,
        slug: str,
        *,
        chain: Optional[str] = None,
        region: Optional[str] = None,
    ) -> Benchmark:
        """Return the full benchmark detail.

        Args:
            slug: Benchmark slug, e.g. ``"bridge-fee"``.
            chain: Optional chain filter (e.g. ``"ethereum"``).
            region: Optional region filter (e.g. ``"eu-west"``).

        Raises:
            NotFoundError: The slug does not exist or is not live.
        """
        params: dict[str, str] = {}
        if chain:
            params["chain"] = chain
        if region:
            params["region"] = region
        data = self._get(f"/api/stat/{slug}", params=params or None)
        return Benchmark.from_dict(data)

    def get_series(
        self,
        slug: str,
        *,
        range: str = "24h",
        chain: Optional[str] = None,
        region: Optional[str] = None,
        providers: Optional[List[str]] = None,
    ) -> Series:
        """Return the per-provider time series for a benchmark.

        Args:
            slug: Benchmark slug.
            range: One of ``"24h"``, ``"7d"``, ``"30d"``.
            chain: Optional chain filter.
            region: Optional region filter.
            providers: Optional list of provider slugs to restrict the result to.

        Raises:
            ValueError: ``range`` is not supported.
            NotFoundError: The slug does not exist or has no data for ``range``.
        """
        if range not in _SUPPORTED_RANGES:
            raise ValueError(
                f"range must be one of {_SUPPORTED_RANGES}, got {range!r}"
            )
        params: dict[str, str] = {"range": range}
        if chain:
            params["chain"] = chain
        if region:
            params["region"] = region
        if providers:
            params["providers"] = ",".join(providers)
        data = self._get(f"/api/series/{slug}", params=params)
        return Series.from_dict(data)

    def close(self) -> None:
        """Close the underlying HTTP client (if owned)."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "OpenChainBench":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def _get(self, path: str, *, params: Optional[dict[str, str]] = None) -> Any:
        try:
            response = self._client.get(path, params=params)
        except httpx.HTTPError as exc:
            raise OpenChainBenchError(f"HTTP request failed: {exc}") from exc
        _raise_for_status(response)
        try:
            return response.json()
        except ValueError as exc:
            raise OpenChainBenchError(
                f"Response was not valid JSON: {exc}"
            ) from exc
