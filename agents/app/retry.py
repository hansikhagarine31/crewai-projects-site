"""Retry with backoff when the language model reports a rate limit (HTTP 429, "resource exhausted").

CrewAI already retries a rate-limited call a few times within about eight seconds. The Gemini free tier
limits requests per minute, so that is often too short; this layer waits longer, and tells the run what it is
doing. Errors that are not rate limits are never retried.

Choice: up to three retries, after about 10, 20 and 40 seconds (each varied by up to 20 per cent so that
calls made together do not retry together). If the API says how long to wait ("retry in 14s"), that is used
when it is longer, up to 90 seconds. The longest total wait is about 70 seconds, which covers one
per-minute window and still finishes inside the server's five-minute limit.
"""
import random
import re
import time
from collections.abc import Callable
from typing import TypeVar

from app.errors import RATE_LIMIT_MESSAGE, RunCancelled, user_message

T = TypeVar("T")

DELAYS = (10.0, 20.0, 40.0)
JITTER = 0.2
MAX_HINT_SECONDS = 90.0

_HINT = re.compile(r"retry(?:delay|\s+in|\s+after)?\W{0,12}(\d+(?:\.\d+)?)\s*s(?:ec\w*)?", re.IGNORECASE)


def is_rate_limit(error: BaseException) -> bool:
    return user_message(error) == RATE_LIMIT_MESSAGE


def retry_hint(error: BaseException) -> float | None:
    """The wait the API asked for, if its message says so."""
    seen, current = set(), error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        match = _HINT.search(str(current))
        if match:
            return float(match.group(1))
        current = current.__cause__ or current.__context__
    return None


def _sleep(seconds: float, cancelled: Callable[[], bool] | None = None) -> None:
    """Sleeps in short steps so that a cancelled run stops waiting."""
    end = time.monotonic() + seconds
    while (remaining := end - time.monotonic()) > 0:
        if cancelled and cancelled():
            raise RunCancelled()
        time.sleep(min(0.5, remaining))


def call_with_backoff(
    call: Callable[[], T],
    *,
    on_wait: Callable[[float, int, int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
    delays: tuple[float, ...] = DELAYS,
    rng: Callable[[], float] | None = None,
) -> T:
    """Runs call(); on a rate-limit error waits and tries again, up to len(delays) times."""
    attempt = 0
    while True:
        try:
            return call()
        except Exception as error:  # noqa: BLE001 - classified below; anything else is re-raised unchanged
            if not is_rate_limit(error) or attempt >= len(delays):
                raise
            delay = delays[attempt] * (1 + JITTER * (2 * (rng or random.random)() - 1))
            hint = retry_hint(error)
            if hint is not None:
                delay = max(delay, min(hint + 1, MAX_HINT_SECONDS))
            attempt += 1
            if on_wait:
                on_wait(delay, attempt, len(delays))
            _sleep(delay, cancelled)


def retrying(emitter, node: str, call: Callable[[], T]) -> T:
    """call_with_backoff for a flow step: tells the run's events when it is waiting, and stops if the run is cancelled."""

    def say(delay: float, attempt: int, total: int) -> None:
        emitter.emit(node, "running", f"Rate limit reached; waiting {delay:.0f} s before retry {attempt} of {total}")

    return call_with_backoff(call, on_wait=say, cancelled=lambda: emitter.cancelled)
