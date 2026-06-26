"""Official Python client for OpenChainBench.

OpenChainBench (https://openchainbench.com) publishes live, reproducible
benchmarks of crypto infrastructure: RPC latency, bridge fees, perp venue
performance, oracle deviation, and more. This package wraps the public,
CC-BY-4.0 licensed JSON API so that Python applications, notebooks, and
agents can cite live numbers without scraping HTML.
"""

from .client import DEFAULT_BASE_URL, OpenChainBench
from .exceptions import (
    APIUnavailableError,
    NotFoundError,
    OpenChainBenchError,
    RateLimitError,
)
from .models import (
    Benchmark,
    BenchmarkSummary,
    CitableIndex,
    Latency,
    Leader,
    ProviderResult,
    Series,
    SeriesProvider,
    Source,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_BASE_URL",
    "OpenChainBench",
    "OpenChainBenchError",
    "NotFoundError",
    "RateLimitError",
    "APIUnavailableError",
    "Benchmark",
    "BenchmarkSummary",
    "CitableIndex",
    "Latency",
    "Leader",
    "ProviderResult",
    "Series",
    "SeriesProvider",
    "Source",
    "__version__",
]
