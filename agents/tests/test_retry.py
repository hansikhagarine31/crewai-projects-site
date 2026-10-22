import pytest

from app import retry
from app.errors import RunCancelled


class RateLimited(Exception):
    pass


def rate_limit(message="429 RESOURCE_EXHAUSTED: quota exceeded"):
    return RateLimited(message)


def flaky(failures, error=None):
    """A call that raises `failures` times and then returns 'ok'."""
    state = {"calls": 0}

    def call():
        state["calls"] += 1
        if state["calls"] <= failures:
            raise error or rate_limit()
        return "ok"

    return call, state


@pytest.fixture
def sleeps(monkeypatch):
    waited = []
    monkeypatch.setattr(retry, "_sleep", lambda seconds, cancelled=None: waited.append(round(seconds, 3)))
    return waited


MIDDLE = lambda: 0.5  # noqa: E731 - no jitter


class TestBackoff:
    def test_a_call_that_succeeds_is_not_delayed(self, sleeps):
        call, state = flaky(0)
        assert retry.call_with_backoff(call, rng=MIDDLE) == "ok"
        assert state["calls"] == 1 and sleeps == []

    def test_a_rate_limit_is_retried_after_10_20_and_40_seconds(self, sleeps):
        call, state = flaky(3)
        assert retry.call_with_backoff(call, rng=MIDDLE) == "ok"
        assert state["calls"] == 4 and sleeps == [10.0, 20.0, 40.0]

    def test_it_gives_up_after_three_retries_and_raises_the_original_error(self, sleeps):
        call, state = flaky(10)
        with pytest.raises(RateLimited):
            retry.call_with_backoff(call, rng=MIDDLE)
        assert state["calls"] == 4 and sleeps == [10.0, 20.0, 40.0]

    def test_the_longest_total_wait_is_about_70_seconds(self):
        assert sum(retry.DELAYS) == 70

    def test_jitter_varies_each_delay_by_at_most_20_per_cent(self, sleeps):
        retry.call_with_backoff(flaky(1)[0], rng=lambda: 0.0)
        retry.call_with_backoff(flaky(1)[0], rng=lambda: 1.0)
        assert sleeps == [8.0, 12.0]

    @pytest.mark.parametrize("message", ["500 internal server error", "invalid API key", "KeyError: 'x'", "The model returned nothing"])
    def test_other_errors_are_never_retried(self, sleeps, message):
        call, state = flaky(5, error=RuntimeError(message))
        with pytest.raises(RuntimeError):
            retry.call_with_backoff(call, rng=MIDDLE)
        assert state["calls"] == 1 and sleeps == []

    @pytest.mark.parametrize("message", ["429 Too Many Requests", "RESOURCE_EXHAUSTED", "rate limit exceeded", "Quota exceeded for metric"])
    def test_the_usual_rate_limit_messages_are_recognised(self, message):
        assert retry.is_rate_limit(RuntimeError(message))

    def test_a_wait_requested_by_the_api_is_used_when_it_is_longer(self, sleeps):
        call, _ = flaky(1, error=rate_limit("429 RESOURCE_EXHAUSTED. Please retry in 25.5s"))
        retry.call_with_backoff(call, rng=MIDDLE)
        assert sleeps == [26.5]

    def test_a_requested_wait_shorter_than_the_backoff_does_not_shorten_it(self, sleeps):
        call, _ = flaky(1, error=rate_limit("429 RESOURCE_EXHAUSTED. retryDelay: 2s"))
        retry.call_with_backoff(call, rng=MIDDLE)
        assert sleeps == [10.0]

    def test_a_requested_wait_is_capped_at_90_seconds(self, sleeps):
        call, _ = flaky(1, error=rate_limit("429 retry in 600s"))
        retry.call_with_backoff(call, rng=MIDDLE)
        assert sleeps == [90.0]

    def test_the_hint_is_found_in_a_wrapped_error(self):
        try:
            try:
                raise rate_limit("429: Please retry in 7s")
            except RateLimited as inner:
                raise RuntimeError("call failed") from inner
        except RuntimeError as outer:
            assert retry.retry_hint(outer) == 7.0

    def test_the_caller_is_told_before_each_wait(self, sleeps):
        told = []
        retry.call_with_backoff(flaky(2)[0], on_wait=lambda delay, attempt, total: told.append((round(delay), attempt, total)), rng=MIDDLE)
        assert told == [(10, 1, 3), (20, 2, 3)]


class TestCancellation:
    def test_a_cancelled_run_stops_waiting(self, monkeypatch):
        monkeypatch.setattr(retry.time, "sleep", lambda seconds: None)
        with pytest.raises(RunCancelled):
            retry._sleep(30, cancelled=lambda: True)

    def test_a_run_that_is_not_cancelled_waits_for_the_full_time(self, monkeypatch):
        clock = {"now": 0.0}
        monkeypatch.setattr(retry.time, "monotonic", lambda: clock["now"])
        monkeypatch.setattr(retry.time, "sleep", lambda seconds: clock.update(now=clock["now"] + seconds))
        retry._sleep(3, cancelled=lambda: False)
        assert clock["now"] == pytest.approx(3)
