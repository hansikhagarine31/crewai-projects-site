"""csv_stats: statistics of an uploaded CSV file, computed with pandas in code, never by a language model.

The CSV arrives as text and is read from memory; nothing is written to or read from the disk. The tool
holds the text itself, so the model never has to pass a file around, and it receives only the result.
"""
import csv
import io
import json
import math
import re
from typing import Any

import pandas as pd
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from app.errors import RunError
from app.untrusted import wrap_untrusted

MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 50
TOP_VALUES = 5
MAX_CELL_CHARS = 60
MAX_OUTPUT_CHARS = 40_000

_DATE_LIKE = re.compile(r"^\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}|\d{1,2}\.\d{1,2}\.\d{2,4})")


class CsvError(RunError):
    """The file cannot be read as CSV. The message is written for the visitor."""


def _number(value: Any) -> int | float | None:
    """A plain Python number: missing and infinite values become None, whole floats become integers."""
    if value is None:
        return None
    value = float(value)
    if math.isnan(value) or math.isinf(value):
        return None
    return int(value) if value == int(value) and abs(value) < 1e15 else round(value, 4)


def _check_structure(text: str, max_rows: int) -> list[str]:
    """Reads the header and checks that every row has as many fields as the header. Returns the header."""
    try:
        reader = csv.reader(io.StringIO(text))
        header = next(reader, None)
        if header is None or not any(cell.strip() for cell in header):
            raise CsvError("The CSV file has no header row.")
        if len(header) == 1 and any(mark in header[0] for mark in (";", "\t", "|")):
            raise CsvError("The header contains ';', a tab or '|'. Only comma-separated files are supported.")
        names = [cell.strip() for cell in header if cell.strip()]
        repeated = sorted({name for name in names if names.count(name) > 1})
        if repeated:
            raise CsvError(f"The header repeats the column name '{repeated[0]}'. Column names must be unique.")
        for count, row in enumerate(reader, start=1):
            if count > max_rows:
                break
            if row and len(row) != len(header):
                raise CsvError(
                    f"The CSV file is malformed: line {reader.line_num} has {len(row)} fields but the header has {len(header)}."
                )
    except csv.Error as error:
        raise CsvError(f"The CSV file is malformed: {str(error).split(' (')[0]}.") from None
    return header


def _kind(series: pd.Series, has_decimal_point: bool) -> tuple[str, pd.Series]:
    """Classifies a column as boolean, integer, decimal, date or text. Date text is converted."""
    if pd.api.types.is_bool_dtype(series):
        return "boolean", series
    if pd.api.types.is_integer_dtype(series):
        return "integer", series
    if pd.api.types.is_float_dtype(series):
        # A column of whole numbers with gaps is read as floats; it is still integers unless the file writes a point.
        present = series.dropna()
        whole = len(present) > 0 and bool((present % 1 == 0).all())
        return ("integer" if whole and not has_decimal_point else "decimal"), series
    if pd.api.types.is_datetime64_any_dtype(series):
        return "date", series
    sample = series.dropna().astype(str).head(50)
    if len(sample) and sample.map(lambda value: bool(_DATE_LIKE.match(value))).mean() >= 0.9:
        parsed = pd.to_datetime(series, errors="coerce", format="mixed")
        if parsed.notna().sum() >= 0.95 * series.notna().sum():
            return "date", parsed
    return "text", series


def _describe_column(name: str, series: pd.Series, raw: pd.Series) -> dict:
    kind, series = _kind(series, bool(raw.str.contains(".", regex=False).any()))
    total = len(series)
    missing = int(series.isna().sum())
    info: dict[str, Any] = {
        "name": name,
        "type": kind,
        "missing": missing,
        "missing_pct": _number(100 * missing / total) if total else 0,
        "unique": int(series.nunique(dropna=True)),
    }
    if kind in ("integer", "decimal"):
        described = series.describe()
        info.update(
            count=int(described["count"]),
            sum=_number(series.sum()),
            mean=_number(described["mean"]),
            std=_number(described["std"]),
            min=_number(described["min"]),
            p25=_number(described["25%"]),
            median=_number(described["50%"]),
            p75=_number(described["75%"]),
            max=_number(described["max"]),
            negatives=int((series < 0).sum()),
        )
        q1, q3 = series.quantile(0.25), series.quantile(0.75)
        spread = q3 - q1
        info["outliers"] = int(((series < q1 - 1.5 * spread) | (series > q3 + 1.5 * spread)).sum()) if spread > 0 else 0
    elif kind == "date":
        valid = series.dropna()
        info.update(earliest=str(valid.min().date()) if len(valid) else None, latest=str(valid.max().date()) if len(valid) else None)
    elif kind == "boolean":
        info.update(true_count=int(series.sum()), false_count=int((~series.dropna().astype(bool)).sum()))
    else:
        top = series.dropna().astype(str).str.slice(0, MAX_CELL_CHARS).value_counts().head(TOP_VALUES)
        info["top_values"] = [{"value": value, "count": int(count)} for value, count in top.items()]
    return info


def compute_csv_stats(text: str, max_rows: int = MAX_ROWS) -> dict:
    """Row count, column names and types, missing values and descriptive statistics of CSV text.

    Raises CsvError, with a message for the visitor, when the text is not usable CSV.
    """
    if not isinstance(text, str) or not text.strip():
        raise CsvError("The CSV file is empty.")
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise CsvError("The CSV file exceeds the limit of 2 MB.")
    if "\x00" in text:
        raise CsvError("The file is not a text CSV file: it contains binary data.")

    header = _check_structure(text, max_rows)
    try:
        frame = pd.read_csv(io.StringIO(text), nrows=max_rows + 1, skipinitialspace=True)
    except pd.errors.EmptyDataError:
        raise CsvError("The CSV file contains no data.") from None
    except (pd.errors.ParserError, ValueError):
        raise CsvError("The CSV file is malformed and could not be read.") from None
    if frame.empty:
        raise CsvError("The CSV file has a header but no data rows.")

    truncated = len(frame) > max_rows
    if truncated:
        frame = frame.iloc[:max_rows]

    # The same rows as text, to see whether the file writes a decimal point (24.0) in a column of whole numbers.
    raw = pd.read_csv(io.StringIO(text), nrows=len(frame), skipinitialspace=True, dtype=str, keep_default_na=False)
    names = [str(column) for column in frame.columns]
    described = [
        _describe_column(name, frame[column], raw[column])
        for name, column in zip(names[:MAX_COLUMNS], frame.columns[:MAX_COLUMNS])
    ]

    quality = []
    for column in described:
        for issue in ("missing", "negatives", "outliers"):
            if column.get(issue):
                quality.append({"column": column["name"], "issue": issue, "count": column[issue]})
        if column["unique"] == 1 and len(frame) > 1 and not column["missing"]:
            quality.append({"column": column["name"], "issue": "constant", "count": len(frame)})
    duplicates = int(frame.duplicated().sum())
    if duplicates:
        quality.append({"column": None, "issue": "duplicate_rows", "count": duplicates})

    return {
        "rows_read": len(frame),
        "truncated": truncated,
        "max_rows": max_rows,
        "column_count": len(names),
        "columns_omitted": names[MAX_COLUMNS:],
        "duplicate_rows": duplicates,
        "columns": described,
        "data_quality": quality,
    }


class CsvStatsInput(BaseModel):
    columns: list[str] | None = Field(
        default=None, description="Optional. Names of the columns to describe. Leave empty to describe all columns."
    )


class CsvStatsTool(BaseTool):
    """Returns the computed statistics of this run's CSV file. It takes no file: the file is already loaded."""

    name: str = "csv_stats"
    description: str = (
        "Returns statistics of the uploaded CSV file, computed in code: row count, column names and types, "
        "missing values per column, descriptive statistics and data-quality counts. Call it with no arguments "
        "to describe every column. Never calculate statistics yourself; copy values from this tool."
    )
    args_schema: type[BaseModel] = CsvStatsInput
    stats: Any = Field(default=None, exclude=True)

    def _run(self, columns: list[str] | None = None) -> str:
        stats = self.stats
        if columns:
            wanted = {name.lower() for name in columns}
            known = {column["name"].lower() for column in stats["columns"]}
            stats = {**stats, "columns": [c for c in stats["columns"] if c["name"].lower() in wanted]}
            stats["unknown_columns"] = sorted(name for name in columns if name.lower() not in known)
        text = json.dumps(stats, ensure_ascii=False, separators=(",", ":"))
        # Column names and cell values come from the file, so they are untrusted data.
        return wrap_untrusted("the uploaded CSV file", text, max_chars=MAX_OUTPUT_CHARS)


def make_csv_stats_tool(stats: dict) -> CsvStatsTool:
    return CsvStatsTool(stats=stats)
