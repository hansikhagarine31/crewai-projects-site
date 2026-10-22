"""Exceptions and the rules that turn failures into messages safe to show a user."""


class RunError(Exception):
    """A failure whose message is written for the user and is safe to show."""


class RunCancelled(Exception):
    """Raised inside a run when the client has disconnected or cancelled."""


GENERIC_MESSAGE = "The run failed unexpectedly."
RATE_LIMIT_MESSAGE = "The language model rate limit was reached. Please try again later."

_RATE_LIMIT_MARKERS = ("429", "resource_exhausted", "rate limit", "ratelimit", "quota")

# Other failures of the language model that the visitor or the owner can act on. Each message is fixed text:
# nothing from the exception is passed on. The full exception is in the agents service log.
KEY_REJECTED_MESSAGE = "The language model rejected the key configured on the agents service."
MODEL_NOT_FOUND_MESSAGE = "The language model name configured on the agents service was not recognised."
UNAVAILABLE_MESSAGE = "The language model is temporarily unavailable. Please try again later."
TIMEOUT_MESSAGE = "The language model did not answer in time. Please try again later."

_KEY_MARKERS = ("api_key_invalid", "api key not valid", "permission_denied", "unauthenticated", "api key expired")
_MODEL_MARKERS = ("is not found for api version", "model not found", "models/")
_UNAVAILABLE_MARKERS = ("unavailable", "overloaded")
_TIMEOUT_MARKERS = ("deadline_exceeded", "timed out", "timeout")


def user_message(exc: BaseException) -> str:
    """Returns a message for the user. Raw exception text is never passed on,
    because it can contain URLs, keys or file paths."""
    if isinstance(exc, RunError):
        return str(exc)
    text = f"{type(exc).__name__} {exc}".lower()
    if any(marker in text for marker in _RATE_LIMIT_MARKERS):
        return RATE_LIMIT_MESSAGE
    if any(marker in text for marker in _KEY_MARKERS):
        return KEY_REJECTED_MESSAGE
    if "not found" in text and any(marker in text for marker in _MODEL_MARKERS):
        return MODEL_NOT_FOUND_MESSAGE
    if any(marker in text for marker in _UNAVAILABLE_MARKERS):
        return UNAVAILABLE_MESSAGE
    if any(marker in text for marker in _TIMEOUT_MARKERS):
        return TIMEOUT_MESSAGE
    return GENERIC_MESSAGE
