import json

import pytest

from app import review_store
from app.review_store import ReviewStore, StoreBusy, StoreExpired, StoreMissing

RUN = "11111111-2222-3333-4444-555555555555"


class Clock:
    def __init__(self, start=1_000_000.0):
        self.now = start

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def store(tmp_path, clock):
    return ReviewStore(tmp_path / "state", ttl_seconds=1800, now=clock)


class TestSaveAndClaim:
    def test_a_waiting_run_is_kept_for_30_minutes(self, store, clock):
        expires = store.save_waiting(RUN, "approval-report-flow", {"draft": "text"})
        assert expires == clock.now + 1800
        assert store.peek(RUN).state == {"draft": "text"}

    def test_claiming_returns_the_state_and_marks_the_run_as_being_resumed(self, store):
        store.save_waiting(RUN, "p", {"a": 1})
        record = store.claim(RUN)
        assert (record.project_id, record.state, record.status) == ("p", {"a": 1}, "resuming")
        assert store.peek(RUN).status == "resuming"

    def test_a_second_claim_is_refused_while_the_first_is_in_progress(self, store):
        store.save_waiting(RUN, "p", {})
        store.claim(RUN)
        with pytest.raises(StoreBusy):
            store.claim(RUN)

    def test_a_run_that_was_never_stored_is_missing(self, store):
        with pytest.raises(StoreMissing):
            store.claim(RUN)

    def test_a_run_whose_time_is_up_has_expired_and_is_deleted(self, store, clock):
        store.save_waiting(RUN, "p", {})
        clock.now += 1800  # exactly at the limit
        with pytest.raises(StoreExpired):
            store.claim(RUN)
        assert store.peek(RUN) is None

    def test_a_run_just_inside_the_limit_can_still_be_claimed(self, store, clock):
        store.save_waiting(RUN, "p", {})
        clock.now += 1799
        assert store.claim(RUN).run_id == RUN

    def test_saving_again_starts_a_new_30_minutes(self, store, clock):
        store.save_waiting(RUN, "p", {"round": 1})
        clock.now += 1700
        store.claim(RUN)
        expires = store.save_waiting(RUN, "p", {"round": 2})
        clock.now += 1700
        assert expires == clock.now - 1700 + 1800 and store.claim(RUN).state == {"round": 2}


class TestDeleteAndPurge:
    def test_delete_removes_the_state_and_says_whether_there_was_any(self, store):
        store.save_waiting(RUN, "p", {})
        assert store.delete(RUN) is True and store.delete(RUN) is False
        assert store.peek(RUN) is None

    def test_purge_removes_only_expired_runs(self, store, clock):
        old, new = "aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002"
        store.save_waiting(old, "p", {})
        clock.now += 1000
        store.save_waiting(new, "p", {})
        clock.now += 801  # the first is now 1801 s old, the second 801 s
        assert store.purge_expired() == 1
        assert store.peek(old) is None and store.peek(new) is not None

    def test_purge_also_removes_unreadable_files(self, store):
        store.directory.mkdir(parents=True)
        (store.directory / "bbbbbbbb-0000-0000-0000-000000000001.json").write_text("not json", encoding="utf-8")
        assert store.purge_expired() == 1
        assert list(store.directory.glob("*.json")) == []

    def test_purging_an_empty_or_missing_directory_is_harmless(self, store):
        assert store.purge_expired() == 0

    def test_the_background_purge_deletes_expired_runs_and_can_be_stopped(self, tmp_path):
        short = ReviewStore(tmp_path / "s", ttl_seconds=0)
        short.save_waiting(RUN, "p", {})
        review_store.set_store(short)
        try:
            stop = review_store.start_purging(interval_seconds=0.05)  # also purges once at once
            stop()
        finally:
            review_store.set_store(None)
        assert short.peek(RUN) is None


class TestFiles:
    def test_the_file_is_named_by_the_run_id_and_holds_plain_json(self, store):
        store.save_waiting(RUN, "p", {"k": "v"})
        data = json.loads((store.directory / f"{RUN}.json").read_text(encoding="utf-8"))
        assert data["state"] == {"k": "v"} and data["status"] == "waiting" and data["project_id"] == "p"

    @pytest.mark.parametrize("bad", ["../etc/passwd", "a/b", "a\\b", "", "x" * 65, "short", "run id with spaces", "id.json"])
    def test_a_run_id_that_is_not_plain_is_refused_so_it_cannot_become_a_path(self, store, bad):
        with pytest.raises(ValueError):
            store.save_waiting(bad, "p", {})

    def test_no_temporary_file_is_left_behind(self, store):
        store.save_waiting(RUN, "p", {})
        assert sorted(p.name for p in store.directory.iterdir()) == [f"{RUN}.json"]

    def test_the_default_directory_is_inside_agents_and_ignored_by_git(self):
        assert review_store.default_directory().name == ".state"
        gitignore = (review_store.default_directory().parent.parent / ".gitignore").read_text(encoding="utf-8")
        assert ".state/" in gitignore
