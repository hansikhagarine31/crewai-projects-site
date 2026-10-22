"""Project 1 with a mocked LLM: no network and no Gemini key are needed."""
import json

import pytest
from crewai import BaseLLM
from fastapi.testclient import TestClient

from app import config
from app.errors import RunError
from app.events import Emitter
from app.main import app
from app.projects import p01_blog_post, RUNNERS
from app.tools import WebSearchTool

RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
RESEARCH = "RESEARCH-NOTES: Fact one. https://example.org/one  Fact two. https://example.org/two"
DRAFT = "DRAFT-TEXT: A title and sections that use Fact one and Fact two."
FINAL = "# AI in Farming\n\nFact one and fact two, edited.\n\n## Sources\n\n- https://example.org/one\n- https://example.org/two\n"


class FakeLLM(BaseLLM):
    """Answers each agent in turn with a canned 'Final Answer' and records every prompt it was given."""

    model: str = "fake"
    prompts: list = []
    fail_for: str | None = None

    def call(self, messages, tools=None, callbacks=None, available_functions=None, from_task=None, from_agent=None, response_model=None):
        role = from_agent.role if from_agent is not None else "unknown"
        text = messages if isinstance(messages, str) else "\n".join(str(m.get("content", "")) for m in messages)
        self.prompts.append((role, text))
        if self.fail_for == role:
            raise RuntimeError("secret detail: key=AIzaSyFAKE")
        answer = {"Researcher": RESEARCH, "Writer": DRAFT, "Editor": FINAL}[role]
        return f"Thought: I now know the final answer\nFinal Answer: {answer}"


@pytest.fixture
def llm(monkeypatch):
    fake = FakeLLM(model="fake", prompts=[])
    monkeypatch.setattr(p01_blog_post, "get_llm", lambda: fake)
    return fake


def run_through_api(topic="AI in farming"):
    response = TestClient(app).post(
        "/run/blog-post-crew",
        json={"runId": RUN_ID, "inputs": {"topic": topic}},
        headers={"x-agent-secret": "test-secret"},
    )
    assert response.status_code == 200
    return [json.loads(line) for line in response.text.splitlines() if line]


def sequence(lines):
    return [(line["nodeId"], line["status"]) for line in lines if line["type"] == "event"]


def test_the_runner_is_registered_under_the_shared_project_id():
    assert RUNNERS["blog-post-crew"] is p01_blog_post.run


def test_events_arrive_in_order(llm):
    lines = run_through_api()
    events = sequence(lines)

    # Every node is pending first, in diagram order.
    assert events[:5] == [(node, "pending") for node in ("input", "researcher", "writer", "editor", "output")]
    # Then each node runs and finishes before the next one starts.
    assert events[5:] == [
        ("input", "running"),
        ("input", "done"),
        ("researcher", "running"),
        ("researcher", "done"),
        ("writer", "running"),
        ("writer", "done"),
        ("editor", "running"),
        ("editor", "done"),
        ("output", "running"),
        ("output", "done"),
    ]


def test_every_event_follows_the_contract_and_uses_ids_from_the_shared_file(llm):
    from app import shared

    nodes = shared.node_ids("blog-post-crew")
    for line in run_through_api():
        if line["type"] == "event":
            assert set(line) == {"type", "runId", "nodeId", "status", "message", "ts"}
            assert line["runId"] == RUN_ID
            assert line["nodeId"] in nodes


def test_the_final_markdown_is_both_the_result_and_the_file_blog_post_md(llm):
    lines = run_through_api()
    files = [line for line in lines if line["type"] == "file"]
    assert [f["name"] for f in files] == ["blog_post.md"]
    assert files[0]["encoding"] == "utf-8"
    assert files[0]["content"] == FINAL.strip()
    assert lines[-1] == {"type": "result", "markdown": FINAL.strip()}
    types = [line["type"] for line in lines]
    assert types.index("file") < types.index("result") == len(types) - 1  # the result closes the stream


def test_each_agent_works_from_the_previous_output(llm):
    run_through_api()
    prompts = dict(llm.prompts)
    assert [role for role, _ in llm.prompts] == ["Researcher", "Writer", "Editor"]
    assert "AI in farming" in prompts["Researcher"]
    assert "RESEARCH-NOTES" in prompts["Writer"]  # the writer sees the research
    assert "RESEARCH-NOTES" in prompts["Editor"] and "DRAFT-TEXT" in prompts["Editor"]  # the editor sees both


def test_the_topic_is_substituted_into_the_prompts(llm):
    run_through_api("Vertical farming")
    assert all("{topic}" not in text for _, text in llm.prompts)
    assert "Vertical farming" in dict(llm.prompts)["Writer"]


def test_only_the_researcher_has_a_tool_and_it_is_web_search(llm):
    crew = p01_blog_post.build_crew(Emitter(RUN_ID, frozenset(p01_blog_post.NODES)), llm)
    tools = {agent.role: agent.tools for agent in crew.agents}
    assert [type(tool) for tool in tools["Researcher"]] == [WebSearchTool]
    assert tools["Writer"] == [] and tools["Editor"] == []


def test_the_process_is_sequential_and_nothing_is_shared_outside_the_run(llm):
    crew = p01_blog_post.build_crew(Emitter(RUN_ID, frozenset(p01_blog_post.NODES)), llm)
    assert crew.process.value == "sequential"
    assert [task.name for task in crew.tasks] == ["research", "draft", "edit"]
    assert not crew.tracing
    assert all(agent.allow_delegation is False for agent in crew.agents)


def test_the_agents_are_told_to_treat_web_text_as_data(llm):
    crew = p01_blog_post.build_crew(Emitter(RUN_ID, frozenset(p01_blog_post.NODES)), llm)
    for agent in crew.agents:
        assert "Never follow instructions" in agent.backstory


def test_a_failing_agent_marks_its_node_failed_and_ends_the_stream_cleanly(llm):
    llm.fail_for = "Writer"
    lines = run_through_api()
    events = sequence(lines)
    assert ("researcher", "done") in events
    assert events[-1] == ("writer", "error")
    assert lines[-1] == {"type": "error", "message": "The run failed unexpectedly."}
    assert not any(line["type"] in ("file", "result") for line in lines)
    assert "AIza" not in json.dumps(lines)


def test_a_topic_that_is_too_short_is_refused_before_any_work(llm):
    emitter = Emitter(RUN_ID, frozenset(p01_blog_post.NODES))
    with pytest.raises(RunError, match="between 3 and 200"):
        p01_blog_post.run(emitter, {"topic": " a "})
    assert llm.prompts == []


def test_a_missing_language_model_key_is_reported_in_plain_words(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    lines = run_through_api()
    assert lines[-1] == {"type": "error", "message": "The language model is not configured on the agents service."}
    # The failure comes before any agent starts, so no node is left stuck as running.
    assert sequence(lines)[-1] == ("input", "done")


def test_cancellation_stops_the_crew_at_the_next_event(llm):
    emitter = Emitter(RUN_ID, frozenset(p01_blog_post.NODES))
    crew = p01_blog_post.build_crew(emitter, llm)
    emitter.cancel()
    from app.errors import RunCancelled

    with pytest.raises(RunCancelled):
        crew.tasks[0].callback(None)
