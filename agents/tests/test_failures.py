"""A failing model must end every project's run cleanly: an error on the failing node, a plain message, no node left active."""
import json
import sys
from pathlib import Path

import pytest
from crewai import BaseLLM
from fastapi.testclient import TestClient

from app import retry
from app.main import app
from app.projects import RUNNERS
from app.tools import scrape as scrape_module
from app.tools import web_search as search_module

SAMPLES = Path(__file__).resolve().parents[2] / "shared" / "samples"
RUN_ID = "aaaaaaaa-1111-2222-3333-444444444444"
SECRET_TEXT = "AIzaSyTHIS-IS-A-FAKE-KEY and a traceback line: File \"x.py\", line 1"

INPUTS = {
    "blog-post-crew": {"topic": "Vertical farming"},
    "competitor-analysis-crew": {"competitors": ["https://one.example/", "https://two.example/"]},
    "meeting-notes-crew": {"transcript": (SAMPLES / "meeting-transcript.txt").read_text(encoding="utf-8")},
    "data-report-crew": {"csv": (SAMPLES / "sales.csv").read_text(encoding="utf-8")},
    "customer-support-flow": {"ticket_text": "I was charged twice for my subscription this month and need a refund."},
    "resume-screening-flow": {
        "job_description": (SAMPLES / "job-description.txt").read_text(encoding="utf-8"),
        "resumes": [{"name": "resume-strong.txt", "text": (SAMPLES / "resumes" / "resume-strong.txt").read_text(encoding="utf-8")}],
    },
    "bug-triage-flow": {"title": "Export fails", "body": "Clicking export shows a blank page after the upload step."},
    "content-repurposing-flow": {"article_text": "A long article about vertical farming. " * 12},
    "lead-qualification-flow": {"lead_name": "Alex Example", "company_name": "Example Company", "website_url": "https://example.com/"},
    "approval-report-flow": {"topic": "Vertical farming", "audience": "City planners"},
}


class FailingLLM(BaseLLM):
    model: str = "failing"

    def call(self, messages, tools=None, callbacks=None, available_functions=None, from_task=None, from_agent=None, response_model=None):
        raise RuntimeError(SECRET_TEXT)


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    from app import review_store

    monkeypatch.setattr(retry, "_sleep", lambda seconds, cancelled=None: None)
    monkeypatch.setattr(search_module, "_search", lambda query, n: [{"title": "One", "href": "https://one.example/", "body": "Text."}])
    monkeypatch.setattr(scrape_module, "read_page", lambda url: (url, "Some page text about the company. " * 5))
    review_store.set_store(review_store.ReviewStore(tmp_path / "state"))
    yield
    review_store.set_store(None)


def failing(monkeypatch, project_id):
    module = sys.modules[RUNNERS[project_id].__module__]
    monkeypatch.setattr(module, "get_llm", lambda: FailingLLM(model="failing"))
    if hasattr(module, "validate_public_url"):
        monkeypatch.setattr(module, "validate_public_url", lambda url, *a, **k: url)


def run(project_id):
    response = TestClient(app).post(f"/run/{project_id}", json={"runId": RUN_ID, "inputs": INPUTS[project_id]}, headers={"x-agent-secret": "test-secret"})
    assert response.status_code == 200
    return [json.loads(line) for line in response.text.splitlines() if line]


@pytest.mark.parametrize("project_id", sorted(INPUTS))
def test_a_failing_model_ends_the_run_cleanly(monkeypatch, project_id):
    failing(monkeypatch, project_id)
    lines = run(project_id)

    events = [line for line in lines if line["type"] == "event"]
    final_state = {}
    for event in events:
        final_state[event["nodeId"]] = event["status"]
    errors = [event for event in events if event["status"] == "error"]

    assert errors, "no node was marked as failed"
    assert not [node for node, status in final_state.items() if status in ("running", "waiting")], "a node was left active"
    assert lines[-1]["type"] == "error"  # the stream ends with the error, and ends
    assert not any(line["type"] in ("result", "waiting") for line in lines)
    for text in [lines[-1]["message"], *(event["message"] for event in errors)]:
        assert text and "AIzaSy" not in text and "Traceback" not in text and "File \"" not in text and "RuntimeError" not in text
        assert text[0].isupper() and text.rstrip().endswith((".", "!", "?"))  # a plain sentence


def test_every_project_has_a_failure_test():
    assert set(INPUTS) == set(RUNNERS) - {"demo"}
