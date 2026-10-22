"""Stored state of runs that are waiting for a person's decision.

One small JSON file per run, named by the run id, in a directory (default agents/.state). A waiting run is
kept for REVIEW_TTL_SECONDS (30 minutes) and then deleted, whether or not anyone asks for it. The service runs as
one process, so a lock inside it is enough to stop two decisions from resuming the same run.
"""
import json
import os
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app import config

_RUN_ID = re.compile(r"^[0-9A-Za-z-]{8,64}$")


class StoreMissing(Exception):
    """No stored state for this run."""


class StoreExpired(Exception):
    """The run waited too long and its state has been deleted."""


class StoreBusy(Exception):
    """The run is already being resumed."""


@dataclass
class Record:
    run_id: str
    project_id: str
    status: str  # "waiting" or "resuming"
    state: dict[str, Any]
    expires_at: float


def default_directory() -> Path:
    return Path(config.REVIEW_STATE_DIR) if config.REVIEW_STATE_DIR else Path(__file__).resolve().parents[1] / ".state"


class ReviewStore:
    def __init__(self, directory: Path | None = None, ttl_seconds: float | None = None, now: Callable[[], float] = time.time):
        self.directory = directory or default_directory()
        self.ttl = config.REVIEW_TTL_SECONDS if ttl_seconds is None else ttl_seconds
        self.now = now
        self._lock = threading.Lock()

    def _path(self, run_id: str) -> Path:
        if not _RUN_ID.match(run_id):  # the id becomes a file name, so it must be plain
            raise ValueError("Invalid run id")
        return self.directory / f"{run_id}.json"

    def _read(self, run_id: str) -> Record | None:
        try:
            data = json.loads(self._path(run_id).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            self._path(run_id).unlink(missing_ok=True)  # an unreadable file is useless; remove it
            return None
        return Record(run_id, data["project_id"], data["status"], data["state"], data["expires_at"])

    def _write(self, record: Record) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self._path(record.run_id)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"project_id": record.project_id, "status": record.status, "state": record.state, "expires_at": record.expires_at}),
            encoding="utf-8",
        )
        os.replace(temporary, path)  # atomic: a reader never sees half a file

    # -- operations -----------------------------------------------------------------------------------

    def save_waiting(self, run_id: str, project_id: str, state: dict[str, Any]) -> float:
        """Stores a waiting run and starts its 30 minutes. Returns the moment it expires (epoch seconds)."""
        expires_at = self.now() + self.ttl
        with self._lock:
            self._write(Record(run_id, project_id, "waiting", state, expires_at))
        return expires_at

    def claim(self, run_id: str) -> Record:
        """Takes a waiting run for resuming. Raises StoreMissing, StoreExpired or StoreBusy."""
        with self._lock:
            record = self._read(run_id)
            if record is None:
                raise StoreMissing(run_id)
            if record.expires_at <= self.now():
                self._path(run_id).unlink(missing_ok=True)
                raise StoreExpired(run_id)
            if record.status != "waiting":
                raise StoreBusy(run_id)
            record.status = "resuming"
            self._write(record)
            return record

    def peek(self, run_id: str) -> Record | None:
        with self._lock:
            return self._read(run_id)

    def delete(self, run_id: str) -> bool:
        with self._lock:
            path = self._path(run_id)
            existed = path.exists()
            path.unlink(missing_ok=True)
            return existed

    def purge_expired(self) -> int:
        """Deletes every stored run whose time is up. Called regularly and when the service starts."""
        removed = 0
        if not self.directory.exists():
            return 0
        with self._lock:
            for path in self.directory.glob("*.json"):
                record = self._read(path.stem)
                if record is None or record.expires_at <= self.now():
                    path.unlink(missing_ok=True)
                    removed += 1
        return removed


# -- the store used by the service -------------------------------------------------------------------

_store: ReviewStore | None = None


def get_store() -> ReviewStore:
    global _store
    if _store is None:
        _store = ReviewStore()
    return _store


def set_store(store: ReviewStore | None) -> None:
    """Replaces the store used by the service (tests use a temporary directory)."""
    global _store
    _store = store


def start_purging(interval_seconds: float = 60.0) -> Callable[[], None]:
    """Deletes expired runs now and then every interval, in a background thread. Returns a function that stops it."""
    stop = threading.Event()
    get_store().purge_expired()

    def loop() -> None:
        while not stop.wait(interval_seconds):
            try:
                get_store().purge_expired()
            except Exception:  # noqa: BLE001 - housekeeping must never stop the service
                pass

    thread = threading.Thread(target=loop, daemon=True, name="review-purge")
    thread.start()
    return stop.set
