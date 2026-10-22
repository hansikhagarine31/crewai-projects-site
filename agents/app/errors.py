"""Exceptions and the rules that turn failures into messages safe to show a user."""


class RunError(Exception):
    """A failure whose message is written for the user and is safe to show."""


class RunCancelled(Exception):
    """Raised inside a run when the client has disconnected or cancelled."""


GENERIC_MESSAGE = "The run failed unexpectedly."
RATE_LIMIT_MESSAGE = "The language model rate limit was reached. Please try again later."

_RATE_LIMIT_MARKERS = ("429", "resource_exhausted", "rate limit", "ratelimit", "quota")


def user_message(exc: BaseException) -> str:
    """Returns a message for the user. Raw exception text is never passed on,
    because it can contain URLs, keys or file paths."""
    if isinstance(exc, RunError):
        return str(exc)
    text = f"{type(exc).__name__} {exc}".lower()
    if any(marker in text for marker in _RATE_LIMIT_MARKERS):
        return RATE_LIMIT_MESSAGE
    return GENERIC_MESSAGE
