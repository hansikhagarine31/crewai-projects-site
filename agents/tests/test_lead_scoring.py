"""The scoring rules and the editable config file. No model is involved: this is arithmetic and validation."""
import textwrap

import pytest

from app import lead_scoring as ls
from app.lead_scoring import Assessment, ConfigError, load_config, parse_config, score_lead

PAGE = "https://acme.example/about"
TEXT = "Acme Widgets builds software for banks. We have 300 employees in London and Dublin. We are hiring 12 engineers."


def valid_data(**changes):
    data = {
        "offer": {"description": "reporting", "sender_name": "[Name]", "sender_company": "[Company]"},
        "thresholds": {"hot": 70, "warm": 40},
        "answers": {"yes": 1.0, "partial": 0.5, "no": 0.0, "unknown": 0.0},
        "criteria": [
            {"id": "industry", "weight": 50, "question": "Is it in banking software?", "guidance": "yes: ..."},
            {"id": "size", "weight": 30, "question": "Does it have 50 to 1,000 staff?"},
            {"id": "growth", "weight": 20, "question": "Is it hiring?"},
        ],
    }
    data.update(changes)
    return data


CONFIG = parse_config(valid_data())


def assess(**answers):
    """Assessments for the three criteria; each value is (answer, quote)."""
    defaults = {"industry": ("unknown", ""), "size": ("unknown", ""), "growth": ("unknown", "")}
    defaults.update(answers)
    return [Assessment(id=cid, answer=a, source=PAGE if q else "", quote=q, reason="") for cid, (a, q) in defaults.items()]


class TestTheDefaultConfigFile:
    def test_it_loads_and_is_valid(self):
        config = load_config()
        assert config.total_weight == sum(c.weight for c in config.criteria) > 0
        assert 0 <= config.warm < config.hot <= 100
        assert set(config.factors) == {"yes", "partial", "no", "unknown"}

    def test_it_is_documented_for_the_person_who_edits_it(self):
        text = ls.DEFAULT_CONFIG.read_text(encoding="utf-8")
        for phrase in ("HOW A LEAD IS SCORED", "The model never decides the label", "thresholds", "weight", "guidance", "never sent anywhere"):
            assert phrase.lower() in text.lower()

    def test_the_bare_yes_and_no_keys_are_read_correctly(self):
        # YAML 1.1 turns the bare words yes and no into booleans; the loader maps them back.
        assert load_config().factors["yes"] == 1.0 and load_config().factors["no"] == 0.0


class TestScoringIsArithmetic:
    def test_a_lead_that_meets_every_criterion_scores_100_and_is_hot(self):
        result = score_lead(assess(industry=("yes", "software for banks"), size=("yes", "300 employees"), growth=("yes", "hiring 12 engineers")), {PAGE: TEXT}, CONFIG)
        assert (result.score, result.label) == (100, "hot")

    def test_partial_answers_earn_half_the_weight(self):
        result = score_lead(assess(industry=("partial", "software for banks"), size=("partial", "300 employees"), growth=("partial", "hiring")), {PAGE: TEXT}, CONFIG)
        assert result.points == 50 and result.score == 50 and result.label == "warm"

    def test_no_and_unknown_earn_nothing(self):
        result = score_lead(assess(industry=("no", ""), size=("unknown", "")), {PAGE: TEXT}, CONFIG)
        assert (result.score, result.label) == (0, "cold")

    @pytest.mark.parametrize(
        "score_points, label",
        [(100, "hot"), (70, "hot"), (69, "warm"), (40, "warm"), (39, "cold"), (0, "cold")],
    )
    def test_the_thresholds_decide_the_label(self, score_points, label):
        assert ls.label_for(score_points, CONFIG) == label

    def test_the_score_is_a_percentage_of_the_total_weight_even_if_weights_do_not_add_to_100(self):
        config = parse_config(valid_data(criteria=[{"id": "a", "weight": 3, "question": "q"}, {"id": "b", "weight": 1, "question": "q"}]))
        items = [Assessment(id="a", answer="yes", source=PAGE, quote="software for banks"), Assessment(id="b", answer="no")]
        assert score_lead(items, {PAGE: TEXT}, config).score == 75

    def test_the_model_has_no_way_to_set_the_label(self):
        # A reply may carry any extra field, including a label; only the criteria answers are used.
        item = Assessment.model_validate({"id": "industry", "answer": "no", "label": "hot", "score": 100})
        items = [item] + assess()[1:]
        assert score_lead(items, {PAGE: TEXT}, CONFIG).label == "cold"


class TestEvidenceIsChecked:
    def test_a_yes_whose_quote_is_on_the_cited_page_counts(self):
        result = score_lead(assess(industry=("yes", "software   for BANKS")), {PAGE: TEXT}, CONFIG)  # case and spacing are ignored
        assert result.rows[0].answer == "yes" and result.score == 50

    def test_a_quote_that_is_not_on_the_page_turns_the_answer_into_unknown(self):
        result = score_lead(assess(industry=("yes", "the market leader in everything")), {PAGE: TEXT}, CONFIG)
        assert result.rows[0].answer == "unknown" and result.score == 0
        assert "industry: the answer was changed to unknown because the quote was not found on the cited page." in result.notes

    def test_a_citation_of_a_page_that_was_not_read_turns_the_answer_into_unknown(self):
        items = [Assessment(id="industry", answer="yes", source="https://other.example/", quote="software for banks")] + assess()[1:]
        result = score_lead(items, {PAGE: TEXT}, CONFIG)
        assert result.rows[0].answer == "unknown"
        assert "was not one of the pages read" in result.rows[0].note

    def test_a_yes_without_any_quote_is_not_accepted(self):
        items = [Assessment(id="industry", answer="yes")] + assess()[1:]
        assert score_lead(items, {PAGE: TEXT}, CONFIG).rows[0].answer == "unknown"

    def test_a_very_short_quote_is_not_accepted(self):
        assert score_lead(assess(industry=("yes", "a")), {PAGE: TEXT}, CONFIG).rows[0].answer == "unknown"

    def test_no_pages_means_no_evidence(self):
        result = score_lead(assess(industry=("yes", "software for banks")), {}, CONFIG)
        assert result.score == 0

    def test_a_no_does_not_need_a_quote(self):
        assert score_lead(assess(industry=("no", "")), {PAGE: TEXT}, CONFIG).rows[0].answer == "no"

    def test_answers_are_read_whatever_their_case(self):
        items = [Assessment(id="industry", answer=" YES ", source=PAGE, quote="software for banks")] + assess()[1:]
        assert score_lead(items, {PAGE: TEXT}, CONFIG).rows[0].answer == "yes"


class TestCheckingAReply:
    def test_a_complete_reply_has_no_problems(self):
        assert ls.check_assessments(assess(), CONFIG) == []

    def test_missing_repeated_unknown_and_invalid_items_are_reported(self):
        items = assess()[:2] + [Assessment(id="size", answer="yes"), Assessment(id="invented", answer="maybe")]
        problems = ls.check_assessments(items, CONFIG)
        assert "criterion 'growth' is missing" in problems
        assert "criterion 'size' appears more than once" in problems
        assert "'invented' is not a criterion" in problems
        assert "the answer for 'invented' must be one of yes, partial, no or unknown" in problems


class TestTheConfigIsValidated:
    @pytest.mark.parametrize(
        "changes, message",
        [
            ({"criteria": []}, "'criteria' must be a list"),
            ({"criteria": "nope"}, "'criteria' must be a list"),
            ({"criteria": [{"id": "Bad Id", "weight": 1, "question": "q"}]}, "needs an 'id'"),
            ({"criteria": [{"id": "a", "weight": 1, "question": "q"}, {"id": "a", "weight": 2, "question": "q"}]}, "used twice"),
            ({"criteria": [{"id": "a", "weight": 0, "question": "q"}]}, "positive whole number"),
            ({"criteria": [{"id": "a", "weight": 2.5, "question": "q"}]}, "positive whole number"),
            ({"criteria": [{"id": "a", "weight": True, "question": "q"}]}, "positive whole number"),
            ({"criteria": [{"id": "a", "weight": 1, "question": " "}]}, "needs a 'question'"),
            ({"thresholds": {"hot": 40, "warm": 70}}, "0 <= warm < hot <= 100"),
            ({"thresholds": {"hot": 101, "warm": 40}}, "0 <= warm < hot <= 100"),
            ({"thresholds": {"hot": 70}}, "whole numbers for 'hot' and 'warm'"),
            ({"answers": {"yes": 1, "partial": 0.5, "no": 0}}, "for each of yes, partial, no and unknown"),
            ({"answers": {"yes": 2, "partial": 0.5, "no": 0, "unknown": 0}}, "from 0 to 1"),
            ({"answers": {"yes": 0.2, "partial": 0.5, "no": 0, "unknown": 0}}, "must not be lower"),
            ({"offer": {"description": "x"}}, "'offer' needs"),
        ],
    )
    def test_a_clear_message_names_the_problem(self, changes, message):
        with pytest.raises(ConfigError, match=message.replace("(", r"\(").replace(")", r"\)").replace("[", r"\[")):
            parse_config(valid_data(**changes))

    def test_a_config_that_is_not_a_mapping_is_refused(self):
        with pytest.raises(ConfigError, match="must be a mapping"):
            parse_config(["a list"])

    def test_the_file_name_appears_in_the_message(self, tmp_path):
        path = tmp_path / "mine.yaml"
        path.write_text("criteria: []\n", encoding="utf-8")
        with pytest.raises(ConfigError, match="mine.yaml"):
            load_config(path)

    def test_a_missing_file_and_a_broken_file(self, tmp_path):
        with pytest.raises(ConfigError, match="was not found"):
            load_config(tmp_path / "absent.yaml")
        broken = tmp_path / "broken.yaml"
        broken.write_text("criteria: [unclosed", encoding="utf-8")
        with pytest.raises(ConfigError, match="could not be read as YAML"):
            load_config(broken)

    def test_the_path_can_be_set_in_the_environment(self, tmp_path, monkeypatch):
        path = tmp_path / "other.yaml"
        path.write_text(
            textwrap.dedent(
                """
                offer: {description: x, sender_name: a, sender_company: b}
                thresholds: {hot: 90, warm: 10}
                answers: {yes: 1, partial: 0.5, no: 0, unknown: 0}
                criteria:
                  - {id: only, weight: 5, question: q}
                """
            ),
            encoding="utf-8",
        )
        monkeypatch.setenv("LEAD_SCORING_CONFIG", str(path))
        config = load_config()
        assert config.hot == 90 and [c.id for c in config.criteria] == ["only"]
