"""Helpers for CSV files that people will open in a spreadsheet."""
from typing import Any

_FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value: Any) -> str:
    """Stops a spreadsheet from treating text as a formula (CSV injection) by prefixing it with an apostrophe."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in _FORMULA_STARTS else text
