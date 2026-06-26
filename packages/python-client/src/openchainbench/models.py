"""Dataclass models that mirror the public OpenChainBench API payloads.

Every model is ``frozen=True`` so instances are safe to share across threads
and cache. Parsing is permissive on unknown fields (the API may add new keys
without bumping a version), but strict on the fields the client documents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence


def _opt_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    return float(value)


def _opt_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    return int(value)


def _opt_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _methodology(value: Any) -> tuple[str, ...]:
    """Methodology can arrive as a list of bullet strings or as a single
    paragraph. Normalize to a tuple of non-empty strings either way."""
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,) if value else ()
    if isinstance(value, Sequence):
        return tuple(str(item) for item in value if item)
    return (str(value),)


@dataclass(frozen=True)
class Leader:
    """The current top provider for a benchmark."""

    name: str
    slug: str
    value: float

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Leader":
        return cls(
            name=str(data["name"]),
            slug=str(data["slug"]),
            value=float(data["value"]),
        )


@dataclass(frozen=True)
class Source:
    """Editorial source attribution for a benchmark.

    The API surfaces ``source`` either as an object (``{type,url,label}``)
    or as a bare URL string for benches whose only attribution is a link.
    Both shapes parse into this dataclass.
    """

    type: Optional[str] = None
    url: Optional[str] = None
    label: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Any) -> Optional["Source"]:
        if data is None:
            return None
        if isinstance(data, str):
            return cls(url=data)
        if isinstance(data, Mapping):
            return cls(
                type=_opt_str(data.get("type")),
                url=_opt_str(data.get("url")),
                label=_opt_str(data.get("label")),
            )
        return None


@dataclass(frozen=True)
class BenchmarkSummary:
    """One row from ``GET /api/citable``.

    The summary is intentionally flat so it can be consumed without
    follow-up calls. ``value`` and ``leader`` are ``None`` when the bench
    is in the ``insufficient`` state (live spec, no usable sample yet).
    """

    slug: str
    title: str
    category: str
    metric: str
    unit: str
    status: str
    value: Optional[float]
    leader: Optional[Leader]
    sample_size: int
    as_of: Optional[str]
    headline: Optional[str]
    url: str
    api_url: str
    og_image: Optional[str]
    source: Optional[Source]
    license: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "BenchmarkSummary":
        leader = data.get("leader")
        return cls(
            slug=str(data["slug"]),
            title=str(data["title"]),
            category=str(data["category"]),
            metric=str(data["metric"]),
            unit=str(data["unit"]),
            status=str(data["status"]),
            value=_opt_float(data.get("value")),
            leader=Leader.from_dict(leader) if leader else None,
            sample_size=int(data.get("sampleSize", 0) or 0),
            as_of=_opt_str(data.get("asOf")),
            headline=_opt_str(data.get("headline")),
            url=str(data.get("url", "")),
            api_url=str(data.get("api", "")),
            og_image=_opt_str(data.get("ogImage")),
            source=Source.from_dict(data.get("source")),
            license=str(data.get("license", "CC-BY-4.0")),
        )


@dataclass(frozen=True)
class Latency:
    """Percentile breakdown for a provider result. Fields can be ``None``
    when the benchmark is in the ``insufficient`` state."""

    p50: Optional[float]
    p90: Optional[float]
    p99: Optional[float]
    mean: Optional[float]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Latency":
        return cls(
            p50=_opt_float(data.get("p50")),
            p90=_opt_float(data.get("p90")),
            p99=_opt_float(data.get("p99")),
            mean=_opt_float(data.get("mean")),
        )


@dataclass(frozen=True)
class ProviderResult:
    """One ranked provider inside a benchmark."""

    name: str
    slug: str
    type: Optional[str]
    layer: Optional[str]
    tag: Optional[str]
    ms: Latency
    success_rate: Optional[float]
    sample_size: Optional[int]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ProviderResult":
        return cls(
            name=str(data["name"]),
            slug=str(data["slug"]),
            type=_opt_str(data.get("type")),
            layer=_opt_str(data.get("layer")),
            tag=_opt_str(data.get("tag")),
            ms=Latency.from_dict(data.get("ms") or {}),
            success_rate=_opt_float(data.get("successRate")),
            sample_size=_opt_int(data.get("sampleSize")),
        )


@dataclass(frozen=True)
class Benchmark:
    """Full payload returned by ``GET /api/stat/<slug>``."""

    slug: str
    title: str
    subtitle: Optional[str]
    category: str
    metric: str
    unit: str
    status: str
    higher_is_better: bool
    value: Optional[float]
    leader: Optional[Leader]
    rankings: Sequence[ProviderResult]
    sparkline: Sequence[float]
    sample_size: int
    as_of: Optional[str]
    headline: Optional[str]
    quote: Optional[str]
    page_url: str
    og_image: Optional[str]
    source: Optional[Source]
    methodology: Sequence[str]
    license: str
    best_per_chain: Optional[Mapping[str, Any]]
    worst_per_chain: Optional[Mapping[str, Any]]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Benchmark":
        leader = data.get("leader")
        rankings = [ProviderResult.from_dict(r) for r in data.get("rankings", []) or []]
        sparkline = [float(v) for v in (data.get("sparkline") or []) if v is not None]
        return cls(
            slug=str(data["slug"]),
            title=str(data["title"]),
            subtitle=_opt_str(data.get("subtitle")),
            category=str(data["category"]),
            metric=str(data["metric"]),
            unit=str(data["unit"]),
            status=str(data["status"]),
            higher_is_better=bool(data.get("higherIsBetter", False)),
            value=_opt_float(data.get("value")),
            leader=Leader.from_dict(leader) if leader else None,
            rankings=tuple(rankings),
            sparkline=tuple(sparkline),
            sample_size=int(data.get("sampleSize", 0) or 0),
            as_of=_opt_str(data.get("asOf")),
            headline=_opt_str(data.get("headline")),
            quote=_opt_str(data.get("quote")),
            page_url=str(data.get("pageUrl", "")),
            og_image=_opt_str(data.get("ogImage")),
            source=Source.from_dict(data.get("source")),
            methodology=_methodology(data.get("methodology")),
            license=str(data.get("license", "CC-BY-4.0")),
            best_per_chain=data.get("bestPerChain"),
            worst_per_chain=data.get("worstPerChain"),
        )


@dataclass(frozen=True)
class SeriesProvider:
    """One provider trace inside a ``Series``."""

    slug: str
    name: str
    color: str
    values: Sequence[float]
    logo: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "SeriesProvider":
        values = [float(v) for v in (data.get("values") or []) if v is not None]
        return cls(
            slug=str(data["slug"]),
            name=str(data["name"]),
            color=str(data.get("color", "#7f7f7f")),
            values=tuple(values),
            logo=_opt_str(data.get("logo")),
        )


@dataclass(frozen=True)
class Series:
    """Payload returned by ``GET /api/series/<slug>``.

    ``timestamps`` and each provider's ``values`` are index-aligned.
    """

    slug: str
    title: str
    metric: str
    unit: str
    higher_is_better: bool
    range: str
    timestamps: Sequence[int]
    providers: Sequence[SeriesProvider] = field(default_factory=tuple)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Series":
        return cls(
            slug=str(data["slug"]),
            title=str(data["title"]),
            metric=str(data["metric"]),
            unit=str(data["unit"]),
            higher_is_better=bool(data.get("higherIsBetter", False)),
            range=str(data["range"]),
            timestamps=tuple(int(t) for t in (data.get("timestamps") or [])),
            providers=tuple(
                SeriesProvider.from_dict(p) for p in (data.get("providers") or [])
            ),
        )


@dataclass(frozen=True)
class CitableIndex:
    """Top-level payload returned by ``GET /api/citable``."""

    site_name: str
    site_url: str
    license: str
    count: int
    benchmarks: Sequence[BenchmarkSummary]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "CitableIndex":
        site = data.get("site") or {}
        benches = [BenchmarkSummary.from_dict(b) for b in data.get("benchmarks", [])]
        return cls(
            site_name=str(site.get("name", "OpenChainBench")),
            site_url=str(site.get("url", "https://openchainbench.com")),
            license=str(site.get("license", "CC-BY-4.0")),
            count=int(data.get("count", len(benches))),
            benchmarks=tuple(benches),
        )
