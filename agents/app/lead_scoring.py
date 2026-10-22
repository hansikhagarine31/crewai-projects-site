"""Lead scoring from an editable config file (agents/config/lead_scoring.yaml).

The language model assesses each criterion. Everything else is arithmetic in this module: how an answer becomes
points, how points become a score, and how a score becomes hot, warm or cold. The model never chooses the label.
"""
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field

from app.errors import RunError

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / "config" / "lead_scoring.yaml"
ANSWERS = ("yes", "partial", "no", "unknown")
LABELS = ("hot", "warm", "cold")
EVIDENCE_ANSWERS = ("yes", "partial")  # these must be backed by a quote from a page that was read


class ConfigError(RunError):
    """The scoring config is not usable. The message says what to fix."""


@dataclass(frozen=True)
class Criterion:
    id: str
    weight: int
    question: str
    guidance: str


@dataclass(frozen=True)
class ScoringConfig:
    criteria: tuple[Criterion, ...]
    hot: int
    warm: int
    factors: dict[str, float]
    offer: dict[str, str]
    path: str = ""

    @property
    def total_weight(self) -> int:
        return sum(criterion.weight for criterion in self.criteria)


def config_path() -> Path:
    return Path(os.environ.get("LEAD_SCORING_CONFIG") or DEFAULT_CONFIG)


def parse_config(data: Any, path: str = "") -> ScoringConfig:
    """Checks the structure of the config and returns it, or raises ConfigError naming the problem."""

    def fail(message: str) -> ConfigError:
        return ConfigError(f"The lead scoring config {path or ''} is not valid: {message}".replace("  ", " "))

    if not isinstance(data, dict):
        raise fail("it must be a mapping.")

    rows = data.get("criteria")
    if not isinstance(rows, list) or not rows:
        raise fail("'criteria' must be a list with at least one criterion.")
    criteria, seen = [], set()
    for number, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise fail(f"criterion {number} must be a mapping.")
        cid, weight, question = row.get("id"), row.get("weight"), row.get("question")
        if not isinstance(cid, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", cid):
            raise fail(f"criterion {number} needs an 'id' of lower-case letters, digits and underscores.")
        if cid in seen:
            raise fail(f"the criterion id '{cid}' is used twice.")
        seen.add(cid)
        if isinstance(weight, bool) or not isinstance(weight, int) or weight <= 0:
            raise fail(f"criterion '{cid}' needs a 'weight' that is a positive whole number.")
        if not isinstance(question, str) or not question.strip():
            raise fail(f"criterion '{cid}' needs a 'question'.")
        criteria.append(Criterion(cid, weight, question.strip(), str(row.get("guidance") or "").strip()))

    thresholds = data.get("thresholds")
    if not isinstance(thresholds, dict) or not all(isinstance(thresholds.get(k), int) and not isinstance(thresholds.get(k), bool) for k in ("hot", "warm")):
        raise fail("'thresholds' needs whole numbers for 'hot' and 'warm'.")
    hot, warm = thresholds["hot"], thresholds["warm"]
    if not 0 <= warm < hot <= 100:
        raise fail("the thresholds must satisfy 0 <= warm < hot <= 100.")

    # YAML 1.1 reads the bare words yes and no as true and false, so those keys are mapped back.
    answers = {("yes" if k is True else "no" if k is False else str(k)): v for k, v in (data.get("answers") or {}).items()}
    if set(answers) != set(ANSWERS) or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1 for v in answers.values()):
        raise fail("'answers' needs a factor from 0 to 1 for each of yes, partial, no and unknown.")
    if not (answers["yes"] >= answers["partial"] >= answers["no"] and answers["partial"] >= answers["unknown"]):
        raise fail("the factor for 'yes' must not be lower than for 'partial', nor 'partial' lower than 'no' or 'unknown'.")

    offer = data.get("offer") or {}
    offer = {key: str(offer.get(key) or "").strip() for key in ("description", "sender_name", "sender_company")}
    if not all(offer.values()):
        raise fail("'offer' needs a 'description', a 'sender_name' and a 'sender_company'.")

    return ScoringConfig(tuple(criteria), hot, warm, {k: float(v) for k, v in answers.items()}, offer, path)


def load_config(path: Path | None = None) -> ScoringConfig:
    path = path or config_path()
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"The lead scoring config {path.name} was not found.") from None
    except (yaml.YAMLError, OSError, UnicodeDecodeError):
        raise ConfigError(f"The lead scoring config {path.name} could not be read as YAML.") from None
    return parse_config(data, path.name)


# --- What the model returns, and how it is checked ---------------------------------------------------


class Assessment(BaseModel):
    id: str = Field(description="The criterion id.")
    answer: str = Field(description="One of: yes, partial, no, unknown.")
    source: str = Field(default="", description="The address of the page the quote is from. Empty if there is no quote.")
    quote: str = Field(default="", description="A short exact quote from that page. Required for yes and partial.")
    reason: str = Field(default="", description="One sentence.")


def _normal(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


@dataclass
class Row:
    criterion: Criterion
    answer: str
    source: str
    quote: str
    reason: str
    points: float
    note: str = ""


@dataclass
class ScoreResult:
    rows: list[Row]
    points: float
    total: int
    score: int
    label: str
    notes: list[str] = field(default_factory=list)


def label_for(score: int, config: ScoringConfig) -> str:
    """The label for a score. This is the only place a label is chosen."""
    return "hot" if score >= config.hot else "warm" if score >= config.warm else "cold"


def check_assessments(items: list[Assessment], config: ScoringConfig) -> list[str]:
    """Problems that make a reply unusable: a missing, repeated or unknown criterion, or an invalid answer."""
    problems = []
    wanted = [c.id for c in config.criteria]
    found = [item.id for item in items]
    for cid in wanted:
        if found.count(cid) == 0:
            problems.append(f"criterion '{cid}' is missing")
        elif found.count(cid) > 1:
            problems.append(f"criterion '{cid}' appears more than once")
    for cid in found:
        if cid not in wanted:
            problems.append(f"'{cid}' is not a criterion")
    for item in items:
        if item.answer.strip().lower() not in ANSWERS:
            problems.append(f"the answer for '{item.id}' must be one of yes, partial, no or unknown")
    return problems


def score_lead(items: list[Assessment], pages: dict[str, str], config: ScoringConfig) -> ScoreResult:
    """Turns assessments into a score and a label.

    An answer of yes or partial is kept only if its quote is found on the page it cites, and that page was one
    that was read; otherwise it becomes 'unknown' and the reason is noted.
    """
    by_id = {item.id: item for item in items}
    normal_pages = {url: _normal(text) for url, text in pages.items()}
    rows, notes, points = [], [], 0.0
    for criterion in config.criteria:
        item = by_id[criterion.id]
        answer = item.answer.strip().lower()
        note = ""
        if answer in EVIDENCE_ANSWERS:
            page = normal_pages.get(item.source)
            if page is None:
                answer, note = "unknown", "the cited page was not one of the pages read"
            elif len(_normal(item.quote)) < 5 or _normal(item.quote) not in page:
                answer, note = "unknown", "the quote was not found on the cited page"
        earned = criterion.weight * config.factors[answer]
        points += earned
        if note:
            notes.append(f"{criterion.id}: the answer was changed to unknown because {note}.")
        rows.append(Row(criterion, answer, item.source if answer in EVIDENCE_ANSWERS else "", item.quote.strip() if answer in EVIDENCE_ANSWERS else "", item.reason.strip(), earned, note))
    score = round(100 * points / config.total_weight)
    return ScoreResult(rows, points, config.total_weight, score, label_for(score, config), notes)
