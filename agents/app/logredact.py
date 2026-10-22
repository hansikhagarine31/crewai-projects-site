"""Keeps secrets out of the logs.

Every line a handler writes, including formatted tracebacks, has anything that looks like a Google API key, and
the exact values of the configured secrets, replaced. It is a second line of defence: the code does not log
secrets, and the messages shown to a visitor never contain them either.
"""
import logging
import re

from app import config

_KEY_PATTERN = re.compile(r"AIza[0-9A-Za-z_-]{35}")
REDACTED = "[redacted]"


def redact(text: str) -> str:
    text = _KEY_PATTERN.sub(REDACTED, text)
    for secret in (config.GEMINI_API_KEY, config.AGENT_SHARED_SECRET):
        if len(secret) >= 8:
            text = text.replace(secret, REDACTED)
    return text


def install(logger_names: tuple[str, ...] = ("", "uvicorn", "uvicorn.error", "uvicorn.access")) -> None:
    """Redacts the output of every handler on the named loggers. Safe to call more than once."""
    for name in logger_names:
        for handler in logging.getLogger(name).handlers:
            if getattr(handler, "_redacting", False):
                continue
            original = handler.format
            handler.format = lambda record, original=original: redact(original(record))  # type: ignore[method-assign]
            handler._redacting = True  # type: ignore[attr-defined]
