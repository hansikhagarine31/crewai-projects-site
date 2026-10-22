import pytest

from app import errors
from app.errors import RunError, user_message

KEY = "AIzaSy" + "B" * 33


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("400 INVALID_ARGUMENT. {'error': {'message': 'API key not valid. Please pass a valid API key.', 'reason': 'API_KEY_INVALID'}}", errors.KEY_REJECTED_MESSAGE),
        ("403 PERMISSION_DENIED. The caller does not have permission", errors.KEY_REJECTED_MESSAGE),
        ("404 NOT_FOUND. models/gemini-9-flash is not found for API version v1beta", errors.MODEL_NOT_FOUND_MESSAGE),
        ("503 UNAVAILABLE. The model is overloaded. Please try again later.", errors.UNAVAILABLE_MESSAGE),
        ("504 DEADLINE_EXCEEDED. The request timed out", errors.TIMEOUT_MESSAGE),
        ("429 RESOURCE_EXHAUSTED. Quota exceeded", errors.RATE_LIMIT_MESSAGE),
        ("something unforeseen", errors.GENERIC_MESSAGE),
        ("the page returned 404 not found", errors.GENERIC_MESSAGE),  # a missing web page is not a missing model
    ],
)
def test_the_failure_is_described_in_fixed_words(text, expected):
    assert user_message(RuntimeError(f"{text} key={KEY} at C:\private\path")) == expected


def test_no_message_contains_text_from_the_exception():
    for text in ("API_KEY_INVALID", "503 UNAVAILABLE", "models/x not found", "timed out", "boom"):
        message = user_message(RuntimeError(f"{text} {KEY}"))
        assert KEY not in message and "private" not in message


def test_a_run_error_keeps_its_own_message():
    assert user_message(RunError("The topic is too short.")) == "The topic is too short."
