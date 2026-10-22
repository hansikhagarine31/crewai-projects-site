import pytest

from app import config

SECRET = "test-secret"


@pytest.fixture(autouse=True)
def shared_secret(monkeypatch):
    monkeypatch.setattr(config, "AGENT_SHARED_SECRET", SECRET)
    return SECRET


@pytest.fixture
def headers():
    return {"x-agent-secret": SECRET}


# --- Event log for the contract test --------------------------------------------------------------------------
# Every event that a project's runner emits during the tests is recorded as (nodeId, status). With RECORD_EVENTS=1 the
# whole suite writes shared/event-logs/<project>.json; the root contract test (npm test at the repository root)
# compares those logs with shared/projects.json and frontend/src/data/projects.js.
import json
import os

from app import shared
from app.events import Emitter

_RECORDED: dict[str, dict[str, set[str]]] = {}
_original_emit = Emitter.emit


def _project_of(node_ids: frozenset[str]) -> str | None:
    matches = [project for project in shared.project_ids() if shared.node_ids(project) == node_ids]
    return matches[0] if len(matches) == 1 else None


def _recording_emit(self, node_id, status, message=""):
    _original_emit(self, node_id, status, message)  # raises for an unknown nodeId or status, so only valid events are recorded
    project = _project_of(self._node_ids)
    if project:
        _RECORDED.setdefault(project, {}).setdefault(node_id, set()).add(status)


Emitter.emit = _recording_emit


def pytest_sessionfinish(session, exitstatus):
    if os.getenv("RECORD_EVENTS") != "1" or exitstatus != 0:
        return
    directory = shared.PROJECTS_FILE.parent / "event-logs"
    directory.mkdir(exist_ok=True)
    for project, nodes in sorted(_RECORDED.items()):
        log = {"projectId": project, "emitted": {node: sorted(statuses) for node, statuses in sorted(nodes.items())}}
        (directory / f"{project}.json").write_text(json.dumps(log, indent=2) + "\n", encoding="utf-8")
