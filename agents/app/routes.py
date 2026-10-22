import threading
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field, model_validator

from app import shared
from app.events import Emitter, stream_run
from app.projects import get_resumer, get_runner
from app.review_store import StoreBusy, StoreExpired, StoreMissing, get_store

router = APIRouter()

_UUID = r"^[0-9a-fA-F-]{8,64}$"
_PROJECT_ID = r"^[a-z0-9-]{1,64}$"
FEEDBACK_MAX = 2000

# Runs whose stream is open, so that one run id cannot be started or resumed twice at once.
_active: dict[str, Emitter] = {}
_active_lock = threading.Lock()


class RunRequest(BaseModel):
    runId: str = Field(pattern=_UUID)
    inputs: dict[str, Any] = Field(default_factory=dict)


class ResumeRequest(BaseModel):
    """A person's decision about a draft that is waiting for review."""

    decision: Literal["approved", "revise"]
    feedback: str = Field(default="", max_length=FEEDBACK_MAX)

    @model_validator(mode="after")
    def revise_needs_feedback(self):
        self.feedback = self.feedback.strip()
        if self.decision == "revise" and not self.feedback:
            raise ValueError("Feedback is required when the decision is to revise.")
        if any(ord(c) < 32 and c not in "\n\t" for c in self.feedback):
            raise ValueError("The feedback contains control characters.")
        return self


def _stream(run_id: str, project_id: str, runner, inputs: dict):
    """Starts a worker for a run (or a resumed part of it) and returns the NDJSON stream."""
    emitter = Emitter(run_id, shared.node_ids(project_id))
    with _active_lock:
        if run_id in _active:
            raise HTTPException(409, "A run with this id is already in progress.")
        _active[run_id] = emitter

    def forget() -> None:
        with _active_lock:
            _active.pop(run_id, None)

    return StreamingResponse(
        stream_run(runner, emitter, inputs, on_finish=forget),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        background=BackgroundTask(forget),  # also covers a client that leaves before the stream starts
    )


@router.post("/run/{project_id}")
async def run_project(project_id: Annotated[str, Field(pattern=_PROJECT_ID)], body: RunRequest):
    if project_id not in shared.project_ids():
        raise HTTPException(404, "Unknown project.")
    runner = get_runner(project_id)
    if runner is None:
        raise HTTPException(501, "This project has not been implemented yet.")
    return _stream(body.runId, project_id, runner, body.inputs)


@router.post("/resume/{run_id}")
async def resume_run(run_id: Annotated[str, Field(pattern=_UUID)], body: ResumeRequest):
    """Continues a run that is waiting for a decision, and streams the rest of it like /run does."""
    with _active_lock:
        if run_id in _active:
            raise HTTPException(409, "The run is already being processed.")
    store = get_store()
    try:
        record = store.claim(run_id)
    except StoreMissing:
        raise HTTPException(404, "No run is waiting with this id.") from None
    except StoreExpired:
        raise HTTPException(410, "The run waited too long for a decision and has expired.") from None
    except StoreBusy:
        raise HTTPException(409, "The run is already being resumed.") from None

    resumer = get_resumer(record.project_id)
    if resumer is None:  # cannot happen for a stored run; release it rather than leave it stuck
        store.delete(run_id)
        raise HTTPException(501, "This project cannot be resumed.")
    decision = body.model_dump()
    return _stream(run_id, record.project_id, lambda emitter, _inputs: resumer(emitter, record, decision), {})


@router.delete("/state/{run_id}", status_code=204)
async def delete_state(run_id: Annotated[str, Field(pattern=_UUID)]):
    """Deletes the stored state of a waiting run (called by the server when a run expires or is cancelled)."""
    get_store().delete(run_id)
    return Response(status_code=204)
