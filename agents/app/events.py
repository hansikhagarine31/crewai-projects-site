"""Run events and the bridge from synchronous CrewAI code to an async NDJSON stream.

A run executes in a worker thread. It puts lines on a thread-safe queue through an
Emitter; an async generator drains the queue and yields one JSON line at a time.
"""
import asyncio
import json
import logging
import queue
import threading
import time
from dataclasses import dataclass
from collections.abc import AsyncIterator, Callable
from typing import Any

from app import config, shared
from app.errors import RunCancelled, RunError, user_message
from app.outputs import OutputCollector

log = logging.getLogger("agents.events")

_DONE = object()
_ACTIVE_STATUSES = {"running", "waiting"}


class Emitter:
    """Collects the lines of one run. Safe to call from any thread."""

    def __init__(self, run_id: str, node_ids: frozenset[str]):
        self.run_id = run_id
        self._node_ids = node_ids
        self._statuses = shared.statuses()
        self._queue: queue.Queue = queue.Queue()
        self._state: dict[str, str] = {}
        self._started = time.monotonic()
        self._lock = threading.Lock()
        self._cancelled = threading.Event()
        self.outputs = OutputCollector(self._put)

    # -- events ---------------------------------------------------------

    def emit(self, node_id: str, status: str, message: str = "") -> None:
        """Queues an event { runId, nodeId, status, message, ts }."""
        self.check_cancelled()
        if node_id not in self._node_ids:
            raise ValueError(f"Unknown nodeId {node_id!r} for this project")
        if status not in self._statuses:
            raise ValueError(f"Unknown status {status!r}")
        with self._lock:
            self._state[node_id] = status
        # One line per step, without the message, so that the host log shows where the time of a run went.
        log.info("Run %s: %s %s (%.1f s since the start)", self.run_id, node_id, status, time.monotonic() - self._started)
        self._put(
            {
                "type": "event",
                "runId": self.run_id,
                "nodeId": node_id,
                "status": status,
                "message": str(message)[:500],
                "ts": int(time.time() * 1000),
            }
        )

    def task_started(self, node_id: str, message: str = "Started") -> Callable[[Any], None]:
        """Returns a CrewAI task callback that marks node_id as running.

        Task callbacks run after a task completes, so attach this to the task
        that comes before node_id. The first node is started with emit().
        """

        def callback(_output: Any = None) -> None:
            self.emit(node_id, "running", message)

        return callback

    def task_done(self, node_id: str, message: str = "Completed") -> Callable[[Any], None]:
        """Returns a CrewAI task callback that marks node_id as done."""

        def callback(_output: Any = None) -> None:
            self.emit(node_id, "done", message)

        return callback

    def task_callback(
        self,
        done: str,
        start: str | None = None,
        done_message: str = "Completed",
        start_message: str = "Started",
    ) -> Callable[[Any], None]:
        """One callback that marks `done` as finished and, if given, `start` as running."""
        finished = self.task_done(done, done_message)
        started = self.task_started(start, start_message) if start else None

        def callback(output: Any = None) -> None:
            finished(output)
            if started:
                started(output)

        return callback

    # -- lifecycle ------------------------------------------------------

    def cancel(self) -> None:
        self._cancelled.set()

    def check_cancelled(self) -> None:
        if self._cancelled.is_set():
            raise RunCancelled()

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def fail_active_nodes(self, message: str) -> None:
        """Marks every node still running or waiting as failed, so the diagram does not stall."""
        with self._lock:
            active = [node for node, status in self._state.items() if status in _ACTIVE_STATUSES]
            for node in active:
                self._state[node] = "error"
        for node in active:
            self._put(
                {
                    "type": "event",
                    "runId": self.run_id,
                    "nodeId": node,
                    "status": "error",
                    "message": message,
                    "ts": int(time.time() * 1000),
                }
            )

    def _put(self, line: dict) -> None:
        self._queue.put(line)

    def get(self, timeout: float) -> Any:
        return self._queue.get(timeout=timeout)


@dataclass
class Waiting:
    """Returned by a runner that has paused for a person's decision. The state was saved before returning.

    The stream ends with a {"type": "waiting", ...payload} line; the run continues when the person's decision
    arrives at POST /resume/{run_id}.
    """

    payload: dict


Runner = Callable[[Emitter, dict], "str | Waiting"]


def _work(runner: Runner, emitter: Emitter, inputs: dict) -> None:
    """Worker thread body. Whatever happens, the queue receives the end marker."""
    try:
        markdown = runner(emitter, inputs)
        if isinstance(markdown, Waiting):
            emitter._put({"type": "waiting", **markdown.payload})
            return
        if not isinstance(markdown, str):
            raise RunError("The project did not return a Markdown result.")
        if len(markdown) > config.MAX_RESULT_CHARS:
            raise RunError("The result exceeds the permitted size.")
        emitter._put({"type": "result", "markdown": markdown})
    except RunCancelled:
        log.info("Run %s cancelled", emitter.run_id)
    except BaseException as exc:  # noqa: BLE001 - the catch-all is the point
        log.exception("Run %s failed", emitter.run_id)
        message = user_message(exc)
        emitter.fail_active_nodes(message)
        emitter._put({"type": "error", "message": message})
    finally:
        emitter._put(_DONE)


def encode(line: dict) -> bytes:
    return (json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


async def stream_run(
    runner: Runner,
    emitter: Emitter,
    inputs: dict,
    on_finish: Callable[[], None] | None = None,
) -> AsyncIterator[bytes]:
    """Runs the project in a worker thread and yields NDJSON lines as they are produced."""
    worker = threading.Thread(target=_work, args=(runner, emitter, inputs), daemon=True, name=f"run-{emitter.run_id}")
    worker.start()
    last_sent = time.monotonic()
    try:
        while True:
            try:
                item = await asyncio.to_thread(emitter.get, 0.25)
            except queue.Empty:
                if time.monotonic() - last_sent >= config.HEARTBEAT_SECONDS:
                    last_sent = time.monotonic()
                    yield encode({"type": "heartbeat"})
                continue
            last_sent = time.monotonic()
            if item is _DONE:
                return
            try:
                data = encode(item)
            except (TypeError, ValueError):
                log.exception("Run %s produced a line that cannot be encoded", emitter.run_id)
                emitter.cancel()
                yield encode({"type": "error", "message": "The run produced output that could not be sent."})
                return
            yield data
    except BaseException:
        # The client went away or the generator failed: stop the worker at its next emit().
        emitter.cancel()
        raise
    finally:
        if on_finish:
            on_finish()
