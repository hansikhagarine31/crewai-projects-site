"""Access to shared/projects.json, the single source of project and node ids."""
import json
from functools import lru_cache
from pathlib import Path

PROJECTS_FILE = Path(__file__).resolve().parents[2] / "shared" / "projects.json"


@lru_cache(maxsize=1)
def _definition() -> dict:
    return json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))


def statuses() -> frozenset[str]:
    return frozenset(_definition()["statuses"])


def project_ids() -> frozenset[str]:
    return frozenset(project["id"] for project in _definition()["projects"])


def node_ids(project_id: str) -> frozenset[str]:
    for project in _definition()["projects"]:
        if project["id"] == project_id:
            return frozenset(node["nodeId"] for node in project["nodes"])
    raise KeyError(project_id)
