import io
import logging

from app import config, logredact

FAKE_KEY = "AIzaSy" + "A" * 33  # shaped like a Google key


def _logger(monkeypatch):
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger = logging.getLogger("logredact-test")
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    monkeypatch.setattr(config, "AGENT_SHARED_SECRET", "")
    logredact.install(("logredact-test",))
    return logger, stream


def test_a_key_shaped_value_is_replaced(monkeypatch):
    logger, stream = _logger(monkeypatch)
    logger.error("request failed for key=%s", FAKE_KEY)
    assert FAKE_KEY not in stream.getvalue()
    assert "[redacted]" in stream.getvalue()


def test_the_configured_secrets_are_replaced_even_when_they_have_no_known_shape(monkeypatch):
    logger, stream = _logger(monkeypatch)
    monkeypatch.setattr(config, "GEMINI_API_KEY", "an-unusual-key-value")
    monkeypatch.setattr(config, "AGENT_SHARED_SECRET", "a-long-shared-secret")
    logger.error("headers: %s %s", "an-unusual-key-value", "a-long-shared-secret")
    assert "an-unusual" not in stream.getvalue() and "a-long-shared" not in stream.getvalue()


def test_a_traceback_is_redacted_too(monkeypatch):
    logger, stream = _logger(monkeypatch)
    try:
        raise RuntimeError(f"upstream refused {FAKE_KEY}")
    except RuntimeError:
        logger.exception("run failed")
    assert FAKE_KEY not in stream.getvalue()
    assert "RuntimeError" in stream.getvalue()


def test_installing_twice_does_not_wrap_twice(monkeypatch):
    logger, stream = _logger(monkeypatch)
    logredact.install(("logredact-test",))
    logger.error("one %s", FAKE_KEY)
    assert stream.getvalue().count("[redacted]") == 1


def test_short_secrets_are_left_alone_so_that_ordinary_words_are_not_removed(monkeypatch):
    logger, stream = _logger(monkeypatch)
    monkeypatch.setattr(config, "AGENT_SHARED_SECRET", "abc")
    logger.error("abcdef")
    assert "abcdef" in stream.getvalue()
