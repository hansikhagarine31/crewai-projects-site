"""Project 6 with a mocked LLM and made-up sample resumes only: no network, no key, no real person's data."""
import csv
import io
import json
from pathlib import Path

import pytest
from crewai import BaseLLM
from fastapi.testclient import TestClient

from app import config, shared
from app.errors import RunError
from app.events import Emitter
from app.main import app
from app.projects import RUNNERS, p06_resume_screening as p06

SAMPLES = Path(__file__).resolve().parents[2] / "shared" / "samples"
JOB = (SAMPLES / "job-description.txt").read_text(encoding="utf-8")
STRONG = (SAMPLES / "resumes" / "resume-strong.txt").read_text(encoding="utf-8")
PARTIAL = (SAMPLES / "resumes" / "resume-partial.txt").read_text(encoding="utf-8")
WEAK = (SAMPLES / "resumes" / "resume-weak.txt").read_text(encoding="utf-8")

RUN_ID = "11111111-2222-3333-4444-aaaaaaaaaaaa"

# Which text identifies which made-up resume to the fake model.
KEYWORDS = {"Northfield": "STRONG", "Lakeside": "PARTIAL", "Harbour": "WEAK"}


def reply(score, rationale="The resume states experience that matches the requirements."):
    return f"SCORE: {score}\nRATIONALE: {rationale}"


class FakeLLM(BaseLLM):
    """Scores by keyword, drafts fixed text, and records every call. Replies can be overridden per resume."""

    model: str = "fake"
    scores: dict = {}
    prompts: list = []
    fail_with: str | None = None

    def call(self, messages, tools=None, callbacks=None, available_functions=None, from_task=None, from_agent=None, response_model=None):
        if self.fail_with:
            raise RuntimeError(self.fail_with)
        if from_agent is not None:  # the small crew
            text = messages if isinstance(messages, str) else "\n".join(str(m.get("content", "")) for m in messages)
            self.prompts.append(("crew", text))
            return "Thought: I now know the final answer\nFinal Answer: Strengths\n- STRENGTH-POINT\nGaps\n- GAP-POINT"
        system, user = messages[0]["content"], messages[1]["content"]
        self.prompts.append((system, user))
        if "screen resumes" in system:
            which = next((kind for word, kind in KEYWORDS.items() if word in user), "WEAK")
            queue = self.scores[which]
            return queue.pop(0) if isinstance(queue, list) else queue
        if "rejection email" in system:
            return "Dear applicant,\n\nThank you for applying. We will not take your application further on this occasion. We wish you well."
        raise AssertionError("unexpected call")


def make_llm(strong=9, partial=7, weak=3):
    return FakeLLM(model="fake", prompts=[], scores={"STRONG": reply(strong), "PARTIAL": reply(partial), "WEAK": reply(weak)})


@pytest.fixture
def llm(monkeypatch):
    fake = make_llm()
    monkeypatch.setattr(p06, "get_llm", lambda: fake)
    return fake


def resumes(*pairs):
    return [{"name": name, "text": text} for name, text in pairs]


THREE = resumes(("strong.txt", STRONG), ("partial.txt", PARTIAL), ("weak.txt", WEAK))


def run_through_api(items=THREE, job=JOB):
    response = TestClient(app).post(
        "/run/resume-screening-flow",
        json={"runId": RUN_ID, "inputs": {"job_description": job, "resumes": items}},
        headers={"x-agent-secret": "test-secret"},
    )
    assert response.status_code == 200
    return [json.loads(line) for line in response.text.splitlines() if line]


def statuses(lines):
    return [(line["nodeId"], line["status"]) for line in lines if line["type"] == "event"]


def csv_rows(lines):
    content = next(line["content"] for line in lines if line["type"] == "file" and line["name"] == "results.csv")
    return list(csv.reader(io.StringIO(content)))


def test_the_runner_is_registered_under_the_shared_project_id():
    assert RUNNERS["resume-screening-flow"] is p06.run


def test_the_node_ids_are_the_ones_in_the_shared_file():
    assert set(p06.NODES) == shared.node_ids("resume-screening-flow")


def test_the_state_has_the_five_fields_from_the_specification():
    assert list(p06.ScreeningState.model_fields) == ["job_description", "resume_text", "score", "rationale", "shortlisted"]


def test_the_flow_has_one_method_per_step():
    for name in ("load_resumes", "score_resume", "check_score", "summary_crew", "draft_rejection", "save_results"):
        assert callable(getattr(p06.ScreeningFlow, name))


class TestOneResumeTwoBranches:
    PENDING = [(node, "pending") for node in p06.NODES]

    def single(self, llm, text):
        return run_through_api(resumes(("one.txt", text)))

    def test_a_high_score_is_shortlisted_and_gets_a_strengths_and_gaps_summary(self, llm):
        lines = self.single(llm, STRONG)
        assert statuses(lines) == self.PENDING + [
            ("load_resumes", "running"),
            ("load_resumes", "done"),
            ("score_resume", "running"),
            ("score_resume", "done"),
            ("check_score", "running"),
            ("check_score", "done"),
            ("draft_rejection", "skipped"),
            ("summary_crew", "running"),
            ("summary_crew", "done"),
            ("or_", "running"),
            ("or_", "done"),
            ("save_results", "running"),
            ("save_results", "done"),
        ]
        assert "STRENGTH-POINT" in lines[-1]["markdown"]

    def test_a_low_score_is_not_shortlisted_and_gets_a_rejection_draft(self, llm):
        lines = self.single(llm, WEAK)
        seen = statuses(lines)
        assert ("summary_crew", "skipped") in seen and ("draft_rejection", "done") in seen
        assert ("summary_crew", "running") not in seen
        assert "Dear applicant" in lines[-1]["markdown"]

    @pytest.mark.parametrize("score, shortlisted", [(10, True), (8, True), (7, True), (6, False), (0, False)])
    def test_the_threshold_is_seven_or_more(self, monkeypatch, score, shortlisted):
        fake = make_llm(strong=score)
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        seen = statuses(run_through_api(resumes(("one.txt", STRONG))))
        assert (("summary_crew", "done") in seen) is shortlisted
        assert (("draft_rejection", "done") in seen) is not shortlisted

    def test_the_router_message_states_the_route_and_the_score(self, llm):
        message = next(l["message"] for l in run_through_api(resumes(("one.txt", STRONG))) if l.get("nodeId") == "check_score" and l["status"] == "done")
        assert message == "Resume 1 of 1: Route: shortlist (score 9, threshold 7)"


class TestRunOncePerResumeAndAggregate:
    def test_each_resume_gets_its_own_pass_through_the_diagram(self, llm):
        seen = statuses(run_through_api())
        assert seen.count(("score_resume", "done")) == 3
        assert seen.count(("save_results", "done")) == 3
        # After the first pass every node is reset to pending before the next resume starts.
        assert seen.count(("score_resume", "pending")) == 3

    def test_events_say_which_resume_they_belong_to(self, llm):
        messages = [l["message"] for l in run_through_api() if l["type"] == "event" and l["nodeId"] == "score_resume" and l["status"] == "done"]
        assert messages == ["Resume 1 of 3: Score: 9/10", "Resume 2 of 3: Score: 7/10", "Resume 3 of 3: Score: 3/10"]

    def test_one_table_holds_every_resume_in_order(self, llm):
        markdown = run_through_api()[-1]["markdown"]
        table = [line for line in markdown.splitlines() if line.startswith("| Resume ") and line[9].isdigit()]
        assert [line.split("|")[1].strip() for line in table] == ["Resume 1", "Resume 2", "Resume 3"]
        assert "| Resume 1 | strong.txt | 9/10 | Shortlisted |" in markdown
        assert "| Resume 2 | partial.txt | 7/10 | Shortlisted |" in markdown
        assert "| Resume 3 | weak.txt | 3/10 | Not shortlisted |" in markdown

    def test_results_csv_is_returned_as_a_file_with_a_row_per_resume(self, llm):
        lines = run_through_api()
        rows = csv_rows(lines)
        assert rows[0][:6] == ["Resume", "File", "Score", "Decision", "Rationale", "Review flag"]
        assert [(r[0], r[1], r[2], r[3]) for r in rows[1:]] == [
            ("Resume 1", "strong.txt", "9", "Shortlisted"),
            ("Resume 2", "partial.txt", "7", "Shortlisted"),
            ("Resume 3", "weak.txt", "3", "Not shortlisted"),
        ]
        assert [l["name"] for l in lines if l["type"] == "file"] == ["results.csv"]

    def test_the_csv_neutralises_text_that_a_spreadsheet_would_run_as_a_formula(self, monkeypatch):
        fake = make_llm()
        fake.scores["STRONG"] = reply(9, "=HYPERLINK(\"http://evil.example\",\"click\") is not a sentence.")
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        rows = csv_rows(run_through_api(resumes(("=cmd.txt", STRONG))))
        assert rows[1][1].startswith("'=") and rows[1][4].startswith("'=")

    def test_the_result_carries_the_advice_note_for_the_human_reviewer(self, llm):
        markdown = run_through_api()[-1]["markdown"]
        assert "advice to a human reviewer" in markdown and "not a hiring decision" in markdown

    def test_pipes_in_text_cannot_break_the_table(self, monkeypatch):
        fake = make_llm()
        fake.scores["STRONG"] = reply(9, "Good fit | with SQL.")
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        markdown = run_through_api(resumes(("a|b.txt", STRONG)))[-1]["markdown"]
        assert "a\\|b.txt" in markdown and "Good fit \\| with SQL." in markdown


class TestScoreParsing:
    @pytest.mark.parametrize(
        "text, expected",
        [
            ("SCORE: 8\nRATIONALE: Strong SQL experience is stated.", (8, "Strong SQL experience is stated.")),
            ("Score: 0\nRationale: Nothing relevant is stated.", (0, "Nothing relevant is stated.")),
            ("SCORE: 7/10\nRATIONALE: Meets most requirements. It also has gaps.", (7, "Meets most requirements.")),
            ("\n  SCORE = 10 \n RATIONALE - All requirements are met!", (10, "All requirements are met!")),
        ],
    )
    def test_valid_replies(self, text, expected):
        assert p06.parse_score_reply(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "8",
            "I would give this resume an eight.",
            "SCORE: eleven\nRATIONALE: x.",
            "SCORE: 11\nRATIONALE: Too high.",
            "SCORE: -1\nRATIONALE: Negative.",
            "SCORE: 7.5\nRATIONALE: Not an integer.",
            "SCORE: 8",
            "RATIONALE: There is no score.",
            "SCORE: 8\nRATIONALE:   ",
        ],
    )
    def test_invalid_replies_are_refused(self, text):
        with pytest.raises(p06.ScoreFormatError):
            p06.parse_score_reply(text)

    def test_a_long_rationale_is_cut_to_one_sentence_and_a_sensible_length(self):
        _, rationale = p06.parse_score_reply("SCORE: 5\nRATIONALE: " + "word " * 100 + ". Second sentence.")
        assert "Second sentence" not in rationale and len(rationale) <= 300


class TestAnUnusableScoreNeverRejects:
    def test_a_bad_reply_is_retried_once(self, monkeypatch):
        fake = make_llm()
        fake.scores["STRONG"] = ["Eight out of ten.", reply(8)]
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        lines = run_through_api(resumes(("one.txt", STRONG)))
        assert ("score_resume", "error") not in statuses(lines)
        assert "| Resume 1 | one.txt | 8/10 | Shortlisted |" in lines[-1]["markdown"]
        assert sum(1 for system, _ in fake.prompts if "screen resumes" in system) == 2

    def test_two_bad_replies_leave_the_resume_not_scored_and_not_rejected(self, monkeypatch):
        fake = make_llm()
        fake.scores["STRONG"] = ["no idea", "still no idea"]
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        lines = run_through_api(resumes(("one.txt", STRONG)))
        markdown = lines[-1]["markdown"]
        assert ("score_resume", "error") in statuses(lines)
        assert ("draft_rejection", "done") not in statuses(lines)  # no rejection email was drafted
        assert "| Resume 1 | one.txt | - | Not scored |" in markdown
        assert "has not been rejected" in markdown
        assert csv_rows(lines)[1][3] == "Not scored"

    def test_the_other_resumes_are_still_processed(self, monkeypatch):
        fake = make_llm()
        fake.scores["STRONG"] = ["bad", "bad"]
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        lines = run_through_api()
        assert lines[-1]["type"] == "result"
        decisions = [r[3] for r in csv_rows(lines)[1:]]
        assert decisions == ["Not scored", "Shortlisted", "Not shortlisted"]


class TestFairness:
    def system_prompts(self, llm):
        return [system for system, _ in llm.prompts if system != "crew"]

    def test_every_direct_prompt_tells_the_model_to_ignore_personal_characteristics(self, llm):
        run_through_api(resumes(("a.txt", STRONG), ("b.txt", WEAK)))
        prompts = self.system_prompts(llm)
        assert len(prompts) >= 3  # two scores and one rejection
        for system in prompts:
            assert "Ignore, and never mention or infer" in system
            for word in ("name", "gender", "age", "nationality"):
                assert word in system

    def test_the_scoring_prompt_limits_the_model_to_stated_skills_and_experience(self, llm):
        run_through_api(resumes(("a.txt", STRONG)))
        system = next(s for s in self.system_prompts(llm) if "screen resumes" in s)
        assert "only the skills, experience, qualifications and achievements that the resume states" in system
        assert "Use no information that is not in the resume" in system

    def test_the_crew_prompt_carries_the_same_guardrails(self, llm):
        run_through_api(resumes(("a.txt", STRONG)))
        crew_prompt = next(text for kind, text in llm.prompts if kind == "crew")
        assert "Ignore, and never mention or infer" in crew_prompt

    def test_the_resume_and_the_job_description_arrive_only_inside_data_markers(self, llm):
        run_through_api(resumes(("a.txt", STRONG)))
        user = next(u for s, u in llm.prompts if "screen resumes" in s)
        assert user.count("<<<DATA ") == 2 and user.count("<<<END DATA ") == 2
        assert user.index("Northfield") > user.index("<<<DATA ") and "untrusted data" in user

    def test_the_rejection_prompt_asks_for_a_neutral_email_without_reasons_or_scores(self, llm):
        run_through_api(resumes(("a.txt", WEAK)))
        system = next(s for s in self.system_prompts(llm) if "rejection email" in s)
        lowered = system.lower()
        assert "polite and neutral" in lowered and "do not mention a score" in lowered and "do not give reasons" in lowered

    def test_the_rejection_prompt_does_not_contain_the_resume_at_all(self, llm):
        run_through_api(resumes(("a.txt", WEAK)))
        system, user = next((s, u) for s, u in llm.prompts if "rejection email" in s)
        assert "Harbour" not in system and "Harbour" not in user

    def test_file_names_are_not_sent_to_the_model(self, llm):
        run_through_api(resumes(("Jordan_Lee_CV.txt", WEAK)))
        assert all("Jordan_Lee_CV" not in system + user for system, user in llm.prompts)

    def test_a_rationale_that_mentions_a_personal_characteristic_is_flagged_for_the_reviewer(self, monkeypatch):
        fake = make_llm()
        fake.scores["STRONG"] = reply(9, "She is a young candidate with relevant skills.")
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        lines = run_through_api(resumes(("one.txt", STRONG)))
        assert csv_rows(lines)[1][5].startswith("Mentions a personal characteristic")
        assert "Mentions a personal characteristic" in lines[-1]["markdown"]

    @pytest.mark.parametrize("text", ["Strong SQL skills and five years of analysis experience.", "Average results on the dashboards project.", "Management of a team of twelve."])
    def test_ordinary_rationales_are_not_flagged(self, text):
        assert p06.personal_flag(text) == ""

    @pytest.mark.parametrize("text", ["A young candidate.", "Aged 41.", "Her nationality is stated.", "The candidate is married.", "Female applicant."])
    def test_personal_characteristics_are_flagged(self, text):
        assert p06.personal_flag(text) != ""


class TestRawFilesNeverReachPython:
    @pytest.mark.parametrize(
        "item",
        [
            {"filename": "cv.pdf", "contentType": "application/pdf", "encoding": "base64", "content": "JVBERi0x"},
            {"name": "cv.pdf", "text": "x" * 50, "content": "JVBERi0x"},
            {"name": "cv.pdf"},
            {"text": "x" * 50},
            "plain string",
            {"name": "cv.pdf", "text": 123},
        ],
    )
    def test_anything_that_is_not_name_and_text_is_refused(self, llm, item):
        with pytest.raises(RunError, match="plain text, not as files"):
            p06.read_inputs({"job_description": JOB, "resumes": [item]})
        assert llm.prompts == []


class TestInputChecks:
    def read(self, **overrides):
        inputs = {"job_description": JOB, "resumes": resumes(("a.txt", STRONG))}
        inputs.update(overrides)
        return p06.read_inputs(inputs)

    @pytest.mark.parametrize("count", [0, 6, 7])
    def test_one_to_five_resumes(self, count):
        with pytest.raises(RunError, match="between 1 and 5 resumes"):
            self.read(resumes=resumes(*[(f"{i}.txt", STRONG) for i in range(count)]))

    def test_five_resumes_are_accepted(self):
        assert len(self.read(resumes=resumes(*[(f"{i}.txt", STRONG) for i in range(5)]))[1]) == 5

    @pytest.mark.parametrize("value", [None, 7, "", "short", "x" * 5001])
    def test_the_job_description_must_be_text_of_a_sensible_length(self, value):
        with pytest.raises(RunError, match="job description"):
            self.read(job_description=value)

    @pytest.mark.parametrize("text", ["", "   ", "short", "x" * 20001])
    def test_each_resume_must_have_a_sensible_amount_of_text(self, text):
        with pytest.raises(RunError, match="Each resume"):
            self.read(resumes=resumes(("a.txt", text)))

    def test_file_names_are_cleaned_for_display(self):
        _, items = self.read(resumes=resumes(("a\nb\x00.txt", STRONG)))
        assert items[0][0] == "ab.txt"


class TestFailures:
    def test_a_rate_limit_ends_the_whole_run_with_a_clear_message(self, monkeypatch):
        fake = make_llm()
        fake.fail_with = "429 RESOURCE_EXHAUSTED: quota exceeded"
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        lines = run_through_api()
        assert lines[-1] == {"type": "error", "message": "The language model rate limit was reached. Please try again later."}
        assert not any(l["type"] in ("file", "result") for l in lines)

    def test_a_failure_does_not_leak_the_exception_text(self, monkeypatch):
        fake = make_llm()
        fake.fail_with = "secret detail: key=AIzaSyFAKE"
        monkeypatch.setattr(p06, "get_llm", lambda: fake)
        assert "AIza" not in json.dumps(run_through_api())

    def test_a_missing_key_is_reported_in_plain_words(self, monkeypatch):
        monkeypatch.setattr(config, "GEMINI_API_KEY", "")
        assert run_through_api()[-1] == {"type": "error", "message": "The language model is not configured on the agents service."}
