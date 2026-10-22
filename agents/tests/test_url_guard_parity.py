"""The Python URL guard must give the same answers as the Node guard (server/test/urlGuardParity.test.js)."""
import json
from pathlib import Path

import pytest

from app.security import UrlGuardError, validate_public_url

CASES = json.loads((Path(__file__).resolve().parents[2] / "shared" / "url-guard-cases.json").read_text(encoding="utf-8"))


def public(_host):
    return ["93.184.216.34"]


@pytest.mark.parametrize("url", CASES["accepted"])
def test_accepts(url):
    validate_public_url(url, public)


@pytest.mark.parametrize("url", CASES["rejected"])
def test_rejects(url):
    with pytest.raises(UrlGuardError):
        validate_public_url(url, public)
