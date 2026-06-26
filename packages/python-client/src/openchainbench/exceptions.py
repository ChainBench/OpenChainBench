"""Exception hierarchy for the OpenChainBench client."""

from __future__ import annotations

from typing import Optional


class OpenChainBenchError(Exception):
    """Base error for every failure surfaced by this client."""

    def __init__(self, message: str, *, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class NotFoundError(OpenChainBenchError):
    """Raised when a benchmark slug or range does not exist."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status_code=404)


class RateLimitError(OpenChainBenchError):
    """Raised when the API returns HTTP 429.

    Attributes:
        retry_after_sec: Seconds the caller should wait before retrying,
            parsed from the ``Retry-After`` header or the response body.
    """

    def __init__(self, message: str, *, retry_after_sec: Optional[int] = None) -> None:
        super().__init__(message, status_code=429)
        self.retry_after_sec = retry_after_sec


class APIUnavailableError(OpenChainBenchError):
    """Raised when the API returns HTTP 503 (no live snapshot available)."""

    def __init__(self, message: str, *, retry_after_sec: Optional[int] = None) -> None:
        super().__init__(message, status_code=503)
        self.retry_after_sec = retry_after_sec
