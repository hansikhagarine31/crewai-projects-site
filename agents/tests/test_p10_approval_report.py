"""Project 10 with a mocked LLM: the whole cycle (run, wait, revise, wait, approve) without network or key."""
import json

import pytest
from crewai import BaseLLM
from fastapi.testclient import TestClient

from app import config, retry, review_store, shared
from app.errors import RunError
from app.events import Emitter
from app.main import app
from app.projects import RESUMERS, RUNNERS, p10_approval_report as p10
from app.review_store import ReviewStore
from app.tools import scrape as scrape_module
from app.tools import web_search as search_module

RUN_ID = "11111111-2222-3333-4444-eeeeeeeeeeee"
HEADERS = {"x-agent-secret": "test-secret"}
SOURCE_ONE, SOURCE_TWO = "https://source-one.example/report", "https://source-two.example/study"

FACTS = [
    {"text": "Vertical farms use controlled light.", "source_url": SOURCE_ONE},
    {"text": "They recycle most of their water.", "source_url": SOURCE_ONE},
    {"text": "Energy is the largest cost.", "source_url": SOURCE_TWO},
    {"text": "Leafy greens suit the method.", "source_url": SOURCE_TWO},
    {"text": "Grain crops do not suit it.", "source_url": SOURCE_ONE},
    {"text": "Most farms are near cities.", "source_url": SOURCE_TWO},
]
NOTES = {"facts": FACTS, "sources": [SOURCE_ONE, SOURCE_TWO]}


def article(version="DRAFT-ONE", extra=""):
    body = " ".join(["Vertical farms grow crops indoors under controlled light and recycle their water."] * 25)
    return f"# Vertical farming\n\n## Summary\n\n{version}. {body}\n\n## Findings\n\n{body}\n{extra}\n\n## Sources\n\n- {SOURCE_ONE}\n- {SOURCE_TWO}\n"


def final(data):
    text = data if isinstance(data, str) else json.dumps(data)
    return "Thought: I now know the final answer\nFinal Answer: " + text


class FakeLLM(BaseLLM):
    model: str = "fake"
    prompts: list = []
    counts: dict = {}
    drafts: list = []  # replies of the Report Writer, then of the Revision Editor, in order
    notes: dict = {}
    fail_role: str | None = None
    fail_with: str = "secret detail: key=AIzaSyFAKE"

    def call(self, messages, tools=None, callbacks=None, available_functions=None, from_task=None, from_agent=None, response_model=None):
        role = from_agent.role if from_agent is not None else "direct"
        text = messages if isinstance(messages, str) else "\n".join(str(m.get("content", "")) for m in messages)
        self.prompts.append((role, text))
        self.counts[role] = self.counts.get(role, 0) + 1
        if role == self.fail_role:
            raise RuntimeError(self.fail_with)
        n = self.counts[role]
        if role == "Web Researcher":
            return 'Thought: search.\nAction: Web search\nAction Input: {"query": "vertical farming"}' if n == 1 else final("Sources: one and two.")
        if role == "Page Reader":
            return f'Thought: read.\nAction: Read website content\nAction Input: {{"website_url": "{SOURCE_ONE}"}}' if n == 1 else final("Facts noted.")
        if role == "Research Editor":
            return final(self.notes or NOTES)
        if role in ("Report Writer", "Revision Editor"):
            return final(self.drafts.pop(0) if len(self.drafts) > 1 else self.drafts[0])
        raise AssertionError(role)


@pytest.fixture
def clock():
    class Clock:
        now = 5_000_000.0

        def __call__(self):
            return self.now

    return Clock()


@pytest.fixture
def world(monkeypatch, tmp_path, clock):
    monkeypatch.setattr(retry, "_sleep", lambda seconds, cancelled=None: None)
    monkeypatch.setattr(
        search_module,
        "_search",
        lambda query, n: [{"title": "One", "href": SOURCE_ONE, "body": "Controlled light."}, {"title": "Two", "href": SOURCE_TWO, "body": "Energy costs."}],
    )
    monkeypatch.setattr(scrape_module, "read_page", lambda url: (url, "Vertical farms use controlled light and recycle water."))
    store = ReviewStore(tmp_path / "state", ttl_seconds=1800, now=clock)
    review_store.set_store(store)
    fake = FakeLLM(model="fake", prompts=[], counts={}, drafts=[article()], notes={})
    monkeypatch.setattr(p10, "get_llm", lambda: fake)
    yield fake, store
    review_store.set_store(None)


def start(topic="Vertical farming", audience="City planners"):
    response = TestClient(app).post(
        "/run/approval-report-flow", json={"runId": RUN_ID, "inputs": {"topic": topic, "audience": audience}}, headers=HEADERS
    )
    assert response.status_code == 200
    return [json.loads(line) for line in response.text.splitlines() if line]


def decide(decision, feedback="", run_id=RUN_ID):
    return TestClient(app).post(f"/resume/{run_id}", json={"decision": decision, "feedback": feedback}, headers=HEADERS)


def lines_of(response):
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line]


def statuses(lines):
    return [(line["nodeId"], line["status"]) for line in lines if line["type"] == "event"]


def messages(lines):
    return {(line["nodeId"], line["status"]): line["message"] for line in lines if line["type"] == "event"}


def test_the_runner_and_the_resumer_are_registered_under_the_shared_project_id():
    assert RUNNERS["approval-report-flow"] is p10.run and RESUMERS["approval-report-flow"] is p10.resume


def test_the_node_ids_are_the_ones_in_the_shared_file():
    assert set(p10.NODES) == shared.node_ids("approval-report-flow")


def test_the_flow_has_one_method_per_step():
    for name in ("collect_topic", "research_crew", "writing_crew", "review_draft", "check_decision", "publish_report", "revision_crew"):
        assert callable(getattr(p10.ReportFlow, name))


class TestTheFirstPartEndsWaiting:
    def test_the_run_reaches_review_draft_and_marks_it_waiting(self, world):
        lines = start()
        assert statuses(lines) == [(n, "pending") for n in p10.NODES] + [
            ("collect_topic", "running"),
            ("collect_topic", "done"),
            ("research_crew", "running"),
            ("research_crew", "done"),
            ("writing_crew", "running"),
            ("writing_crew", "done"),
            ("review_draft", "waiting"),
        ]
        assert messages(lines)[("review_draft", "waiting")] == "Waiting for your decision on draft 1"

    def test_the_stream_ends_with_a_waiting_line_that_carries_the_draft(self, world, clock):
        lines = start()
        last = lines[-1]
        assert last["type"] == "waiting"
        review = last["review"]
        assert review["draft"].startswith("# Vertical farming") and "DRAFT-ONE" in review["draft"]
        assert (review["round"], review["revisionsUsed"], review["revisionsLeft"], review["maxRevisions"]) == (1, 0, 3, 3)
        assert review["expiresAt"] == int((clock.now + 1800) * 1000)
        assert not any(line["type"] in ("result", "file", "error") for line in lines)

    def test_check_decision_does_not_start_before_there_is_a_decision(self, world):
        started = [(node, status) for node, status in statuses(start()) if status != "pending"]
        assert not any(node in ("check_decision", "publish_report", "revision_crew") for node, _ in started)

    def test_the_state_is_saved_for_30_minutes_keyed_by_the_run_id(self, world, clock):
        _, store = world
        start()
        record = store.peek(RUN_ID)
        assert record.status == "waiting" and record.project_id == "approval-report-flow"
        assert record.expires_at == clock.now + 1800
        assert record.state["topic"] == "Vertical farming" and record.state["phase"] == "awaiting_review"
        assert "DRAFT-ONE" in record.state["draft"] and len(record.state["facts"]) == 6

    def test_no_secret_is_written_to_the_stored_state(self, world, monkeypatch):
        _, store = world
        monkeypatch.setattr(config, "GEMINI_API_KEY", "AIza-secret-key-for-the-test")
        start()
        assert "AIza-secret-key-for-the-test" not in (store.directory / f"{RUN_ID}.json").read_text(encoding="utf-8")

    def test_the_research_crew_has_three_agents_and_lists_its_sources(self, world):
        fake, _ = world
        start()
        assert {role for role, _ in fake.prompts} >= {"Web Researcher", "Page Reader", "Research Editor"}
        draft_prompt = next(text for role, text in fake.prompts if role == "Report Writer")
        assert SOURCE_ONE in draft_prompt and SOURCE_TWO in draft_prompt and "Energy is the largest cost." in draft_prompt

    def test_the_writer_is_told_to_use_only_the_research(self, world):
        fake, _ = world
        start()
        prompt = next(text for role, text in fake.prompts if role == "Report Writer")
        assert "Use only the research notes you are given" in prompt and "<<<DATA " in prompt


class TestReviseOnceThenApprove:
    def test_the_full_cycle(self, world, clock):
        fake, store = world
        fake.drafts = [article("DRAFT-ONE"), article("DRAFT-TWO", "Shorter introduction applied.")]
        first = start()
        assert first[-1]["type"] == "waiting"
        research_calls = {k: v for k, v in fake.counts.items() if k in ("Web Researcher", "Page Reader", "Research Editor")}

        # The reviewer asks for a revision.
        clock.now += 600
        second = lines_of(decide("revise", "Please shorten the introduction."))
        assert statuses(second) == [
            ("review_draft", "done"),
            ("check_decision", "running"),
            ("publish_report", "skipped"),
            ("check_decision", "done"),
            ("revision_crew", "running"),
            ("revision_crew", "done"),
            ("review_draft", "waiting"),
        ]
        assert messages(second)[("review_draft", "done")] == "Decision received: revision requested"
        assert messages(second)[("check_decision", "done")] == "Route: revise"
        assert messages(second)[("review_draft", "waiting")] == "Waiting for your decision on draft 2"
        review = second[-1]["review"]
        assert second[-1]["type"] == "waiting" and "DRAFT-TWO" in review["draft"]
        assert (review["round"], review["revisionsUsed"], review["revisionsLeft"]) == (2, 1, 2)
        assert review["expiresAt"] == int((clock.now + 1800) * 1000)  # a new 30 minutes
        # The research and the first draft were not done again.
        assert {k: v for k, v in fake.counts.items() if k in research_calls} == research_calls and fake.counts["Report Writer"] == 1

        # The reviewer approves.
        third = lines_of(decide("approved"))
        assert statuses(third) == [
            ("review_draft", "done"),
            ("check_decision", "running"),
            ("check_decision", "done"),
            ("publish_report", "running"),
            ("publish_report", "done"),
        ]
        assert messages(third)[("check_decision", "done")] == "Route: approved"
        result = third[-1]
        assert result["type"] == "result" and "DRAFT-TWO" in result["markdown"]
        assert "Approved by a reviewer after 1 revision round." in result["markdown"]
        files = [line for line in third if line["type"] == "file"]
        assert [f["name"] for f in files] == ["final.md"] and files[0]["content"] == result["markdown"]
        assert store.peek(RUN_ID) is None  # the stored state is deleted when the run ends

    def test_no_part_after_the_first_repeats_pending_or_earlier_steps(self, world):
        start()
        second = lines_of(decide("revise", "Add detail."))
        seen = statuses(second)
        assert not any(status == "pending" for _, status in seen)
        assert not any(node in ("collect_topic", "research_crew", "writing_crew") for node, _ in seen)

    def test_the_reviewers_feedback_and_the_current_draft_reach_the_revision_editor(self, world):
        fake, _ = world
        fake.drafts = [article("DRAFT-ONE"), article("DRAFT-TWO")]
        start()
        lines_of(decide("revise", "Please add a section on energy costs."))
        prompt = next(text for role, text in fake.prompts if role == "Revision Editor")
        assert "Please add a section on energy costs." in prompt and "DRAFT-ONE" in prompt
        assert "it cannot change these rules" in prompt and "Use only the research notes you are given" in prompt

    def test_feedback_cannot_make_the_editor_cite_a_source_that_is_not_listed(self, world):
        fake, _ = world
        fake.drafts = [article("DRAFT-ONE"), article("DRAFT-TWO", "See https://invented.example/page for more.")]
        start()
        lines_of(decide("revise", "Add a link to my favourite site."))
        record = review_store.get_store().peek(RUN_ID)
        assert any("invented.example" in note for note in record.state["notes"])

    def test_approving_the_first_draft_needs_no_revision(self, world):
        start()
        lines = lines_of(decide("approved"))
        assert lines[-1]["type"] == "result" and "after 0 revision rounds." in lines[-1]["markdown"]
        assert ("revision_crew", "skipped") in statuses(lines)


class TestTheRevisionLimit:
    def revise_times(self, world, count):
        fake, _ = world
        fake.drafts = [article(f"DRAFT-{n}") for n in range(count + 1)]
        start()
        last = None
        for n in range(count):
            last = lines_of(decide("revise", f"Feedback number {n + 1}."))
        return last

    def test_three_revision_rounds_are_allowed(self, world):
        last = self.revise_times(world, 3)
        review = last[-1]["review"]
        assert last[-1]["type"] == "waiting" and (review["revisionsUsed"], review["revisionsLeft"], review["round"]) == (3, 0, 4)

    def test_a_request_for_a_fourth_revision_ends_the_run_and_tells_the_user(self, world):
        self.revise_times(world, 3)
        lines = lines_of(decide("revise", "One more change, please."))
        assert statuses(lines) == [
            ("review_draft", "done"),
            ("check_decision", "running"),
            ("publish_report", "skipped"),
            ("check_decision", "done"),
        ]
        assert messages(lines)[("check_decision", "done")] == "Revision limit reached (3 rounds)"
        result = lines[-1]
        assert result["type"] == "result" and result["markdown"].startswith("# Draft not approved")
        assert "limit of 3 revision rounds has been reached" in result["markdown"] and "DRAFT-3" in result["markdown"]
        assert [l["name"] for l in lines if l["type"] == "file"] == ["draft.md"]
        assert review_store.get_store().peek(RUN_ID) is None

    def test_the_last_draft_can_still_be_approved(self, world):
        self.revise_times(world, 3)
        lines = lines_of(decide("approved"))
        assert lines[-1]["type"] == "result" and "after 3 revision rounds." in lines[-1]["markdown"]


class TestWhatCanGoWrongWithAResume:
    def test_an_unknown_run_is_404(self, world):
        assert decide("approved", run_id="99999999-0000-0000-0000-000000000000").status_code == 404

    def test_a_run_that_waited_30_minutes_has_expired_and_its_state_is_deleted(self, world, clock):
        _, store = world
        start()
        clock.now += 1800
        response = decide("approved")
        assert response.status_code == 410 and "expired" in response.json()["detail"]
        assert store.peek(RUN_ID) is None
        assert decide("approved").status_code == 404  # and it is gone

    def test_a_decision_just_inside_30_minutes_is_accepted(self, world, clock):
        start()
        clock.now += 1799
        assert decide("approved").status_code == 200

    def test_two_decisions_for_one_run_cannot_both_be_taken(self, world):
        _, store = world
        start()
        store.claim(RUN_ID)  # the first decision is being processed
        response = decide("approved")
        assert response.status_code == 409 and "already being resumed" in response.json()["detail"]

    def test_a_second_decision_after_the_run_ended_finds_nothing(self, world):
        start()
        lines_of(decide("approved"))
        assert decide("approved").status_code == 404

    @pytest.mark.parametrize(
        "body",
        [
            {"decision": "maybe", "feedback": "x"},
            {"decision": "revise"},
            {"decision": "revise", "feedback": ""},
            {"decision": "revise", "feedback": "   "},
            {"decision": "revise", "feedback": "x" * 2001},
            {"decision": "revise", "feedback": "bad\x00text"},
            {"feedback": "no decision"},
            {},
        ],
    )
    def test_an_invalid_decision_is_refused_and_leaves_the_run_waiting(self, world, body):
        _, store = world
        start()
        response = TestClient(app).post(f"/resume/{RUN_ID}", json=body, headers=HEADERS)
        assert response.status_code == 422
        assert store.peek(RUN_ID).status == "waiting"

    def test_feedback_of_exactly_2000_characters_is_accepted(self, world):
        start()
        assert decide("revise", "x" * 2000).status_code == 200

    def test_approving_needs_no_feedback_and_ignores_any(self, world):
        start()
        assert lines_of(decide("approved", "thank you"))[-1]["type"] == "result"

    def test_the_secret_is_required(self, world):
        assert TestClient(app).post(f"/resume/{RUN_ID}", json={"decision": "approved"}).status_code == 401

    def test_a_failure_while_revising_ends_the_run_and_deletes_the_state(self, world):
        fake, store = world
        start()
        fake.fail_role = "Revision Editor"
        lines = lines_of(decide("revise", "Change it."))
        assert lines[-1] == {"type": "error", "message": "The run failed unexpectedly."} and "AIza" not in json.dumps(lines)
        assert ("revision_crew", "error") in statuses(lines)
        assert store.peek(RUN_ID) is None

    def test_a_rate_limit_while_revising_is_waited_out(self, world, monkeypatch):
        fake, _ = world
        fake.drafts = [article("DRAFT-ONE"), article("DRAFT-TWO")]
        start()
        waited = []
        monkeypatch.setattr(retry, "_sleep", lambda seconds, cancelled=None: waited.append(round(seconds)))
        original = fake.call
        state = {"n": 0}

        def flaky(messages, **kwargs):
            agent = kwargs.get("from_agent")
            if agent is not None and agent.role == "Revision Editor" and state["n"] == 0:
                state["n"] += 1
                raise RuntimeError("429 RESOURCE_EXHAUSTED")
            return original(messages, **kwargs)

        object.__setattr__(fake, "call", flaky)
        lines = lines_of(decide("revise", "Change it."))
        assert lines[-1]["type"] == "waiting" and len(waited) == 1


class TestDeletingStoredState:
    def test_the_server_can_delete_the_stored_state_of_a_waiting_run(self, world):
        _, store = world
        start()
        assert TestClient(app).delete(f"/state/{RUN_ID}", headers=HEADERS).status_code == 204
        assert store.peek(RUN_ID) is None
        assert decide("approved").status_code == 404

    def test_deleting_state_that_does_not_exist_is_harmless(self, world):
        assert TestClient(app).delete("/state/99999999-0000-0000-0000-000000000000", headers=HEADERS).status_code == 204

    def test_the_secret_is_required(self, world):
        assert TestClient(app).delete(f"/state/{RUN_ID}").status_code == 401

    def test_a_run_id_that_is_not_plain_is_refused(self, world):
        assert TestClient(app).delete("/state/..%2F..%2Fetc", headers=HEADERS).status_code in (404, 422)


class TestTheResearch:
    def test_facts_that_cite_a_source_that_was_never_found_are_dropped_and_noted(self, world):
        fake, store = world
        fake.notes = {"facts": FACTS + [{"text": "An invented fact.", "source_url": "https://invented.example/x"}], "sources": [SOURCE_ONE]}
        start()
        state = store.peek(RUN_ID).state
        assert all(f["source_url"] != "https://invented.example/x" for f in state["facts"])
        assert "1 fact(s) were dropped because they did not cite a source that was found." in state["notes"]
        assert "https://invented.example/x" not in state["sources"]

    def test_when_there_are_no_usable_facts_the_run_ends_with_a_clear_message(self, world):
        fake, store = world
        fake.notes = {"facts": [{"text": "Made up.", "source_url": "https://invented.example/x"}], "sources": []}
        lines = start()
        assert lines[-1] == {"type": "error", "message": "No usable research could be found for this topic. Try a more specific topic."}
        assert store.peek(RUN_ID) is None and ("research_crew", "error") in statuses(lines)

    def test_a_page_that_cannot_be_read_does_not_stop_the_run(self, world, monkeypatch):
        monkeypatch.setattr(scrape_module, "read_page", lambda url: (_ for _ in ()).throw(scrape_module.PageReadError("The page could not be retrieved.")))
        assert start()[-1]["type"] == "waiting"  # the search results alone were enough to cite

    def test_the_agents_may_read_no_more_than_four_pages(self):
        log = p10.ResearchLog()
        tool = p10.ReadPageTool(log=log)
        log.reads = 4
        assert "limit of four pages" in tool.run(website_url="https://example.com/")


class TestTheDraftIsChecked:
    def test_the_checks(self):
        sources = [SOURCE_ONE]
        assert p10.check_draft(article().replace(f"- {SOURCE_TWO}\n", ""), sources) == []
        problems = p10.check_draft("No heading. See https://x.example/y", sources)
        assert any("level-one heading" in p for p in problems) and any("250 and 1200" in p for p in problems)
        assert any("https://x.example/y, which is not one of the listed sources" in p for p in problems)

    def test_a_draft_that_breaks_the_rules_is_regenerated_once_then_kept_with_a_note(self, world):
        fake, store = world
        fake.drafts = ["too short"]
        start()
        assert fake.counts["Report Writer"] == 2  # exactly one regeneration
        notes = store.peek(RUN_ID).state["notes"]
        assert any("The draft still has problems after one regeneration" in n for n in notes)


class TestInputs:
    @pytest.mark.parametrize("inputs", [{}, {"topic": "ab", "audience": "People"}, {"topic": "Farming", "audience": ""}, {"topic": "t" * 201, "audience": "People"}, {"topic": 5, "audience": "x"}, {"topic": "Bad\x00topic", "audience": "People"}])
    def test_the_topic_and_the_audience_must_be_sensible_text(self, world, inputs):
        fake, store = world
        with pytest.raises(RunError):
            p10.read_inputs(inputs)

    def test_a_missing_key_is_reported_in_plain_words_and_nothing_is_stored(self, world, monkeypatch):
        from app.llm import get_llm as real_get_llm

        _, store = world
        monkeypatch.setattr(p10, "get_llm", real_get_llm)
        monkeypatch.setattr(config, "GEMINI_API_KEY", "")
        lines = start()
        assert lines[-1] == {"type": "error", "message": "The language model is not configured on the agents service."}
        assert store.peek(RUN_ID) is None
