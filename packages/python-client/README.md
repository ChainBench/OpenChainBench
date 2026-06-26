# openchainbench

Official Python client for [OpenChainBench](https://openchainbench.com), the live, reproducible benchmark suite for crypto infrastructure (RPC latency, bridge fees, perp venues, oracle deviation, and more).

[![PyPI version](https://img.shields.io/pypi/v/openchainbench.svg)](https://pypi.org/project/openchainbench/)
[![Python versions](https://img.shields.io/pypi/pyversions/openchainbench.svg)](https://pypi.org/project/openchainbench/)
[![Downloads](https://img.shields.io/pypi/dm/openchainbench.svg)](https://pypi.org/project/openchainbench/)
[![License](https://img.shields.io/pypi/l/openchainbench.svg)](https://github.com/ChainBench/OpenChainBench/blob/main/LICENSE)

The data served by openchainbench.com is published under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Attribute with a link back to the benchmark page (`pageUrl` on every payload).

## Install

```bash
pip install openchainbench
```

Requires Python 3.10+.

## Quick start

```python
from openchainbench import OpenChainBench

with OpenChainBench() as ocb:
    for bench in ocb.list_benchmarks():
        if bench.leader:
            print(f"{bench.title}: {bench.leader.name} -> {bench.value}")
```

### Fetch one benchmark

```python
from openchainbench import OpenChainBench

with OpenChainBench() as ocb:
    bench = ocb.get_benchmark("bridge-fee")
    print(bench.headline)
    for row in bench.rankings[:3]:
        print(row.slug, row.ms.p50, row.success_rate)
```

### Fetch a time series

```python
from openchainbench import OpenChainBench

with OpenChainBench() as ocb:
    series = ocb.get_series("bridge-fee", range="24h")
    for provider in series.providers:
        print(provider.name, provider.values[-1])
```

### Filter by chain or region

```python
bench = ocb.get_benchmark("network-fees", chain="ethereum")
series = ocb.get_series("network-fees", range="7d", chain="ethereum", region="eu-west")
```

## Error handling

The client maps HTTP responses to a typed exception hierarchy so callers
can react to intent rather than status codes.

```python
from openchainbench import (
    OpenChainBench,
    NotFoundError,
    RateLimitError,
    APIUnavailableError,
)

with OpenChainBench() as ocb:
    try:
        ocb.get_benchmark("not-a-real-slug")
    except NotFoundError:
        ...
    except RateLimitError as exc:
        print(f"retry after {exc.retry_after_sec}s")
    except APIUnavailableError:
        # cold cache or Prom blackout, retry later
        ...
```

## API reference

| Method | Endpoint | Returns |
|---|---|---|
| `list_benchmarks()` | `GET /api/citable` | `list[BenchmarkSummary]` |
| `fetch_citable_index()` | `GET /api/citable` | `CitableIndex` |
| `get_benchmark(slug, *, chain=None, region=None)` | `GET /api/stat/<slug>` | `Benchmark` |
| `get_series(slug, *, range="24h", chain=None, region=None, providers=None)` | `GET /api/series/<slug>` | `Series` |

All models are immutable dataclasses (`frozen=True`).

## Rate limits

The public API allows 60 requests per minute per IP. The client surfaces
HTTP 429 as a `RateLimitError` with a `retry_after_sec` attribute.

## Citation

If you use the data in a paper, post, or product, please link the
benchmark page. The license is CC-BY-4.0. Every payload includes a
ready-to-paste `quote` field that already contains the attribution.

## Links

- Site: <https://openchainbench.com>
- Docs: <https://openchainbench.com/docs>
- Repository: <https://github.com/ChainBench/OpenChainBench>
- Issues: <https://github.com/ChainBench/OpenChainBench/issues>

## License

MIT. The data fetched from the API stays under CC-BY-4.0; this client
license only covers the code.
