"""Output files are returned to the caller as stream lines; agents never touch the disk."""
import base64
import re
import threading
from collections.abc import Callable

from app import config
from app.errors import RunError

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def safe_name(name: str) -> str:
    cleaned = _SAFE_NAME.sub("_", name.replace("\\", "/").rsplit("/", 1)[-1])[:100]
    if not cleaned or cleaned.startswith("."):
        raise RunError("An output file had an unusable name.")
    return cleaned


class OutputCollector:
    """Registers output files. Each file is sent on as a "file" line as soon as it is added."""

    def __init__(self, on_file: Callable[[dict], None]):
        self._on_file = on_file
        self._lock = threading.Lock()
        self._names: set[str] = set()
        self._bytes = 0

    def add_file(self, name: str, content: str | bytes) -> str:
        """Registers a file and returns the name it will be served under."""
        name = safe_name(name)
        if isinstance(content, bytes):
            raw, encoding, text = content, "base64", base64.b64encode(content).decode("ascii")
        else:
            raw, encoding, text = content.encode("utf-8"), "utf-8", content
        with self._lock:
            if name in self._names:
                raise RunError(f"The output file {name} was registered twice.")
            if len(self._names) >= config.MAX_OUTPUT_FILES:
                raise RunError("Too many output files were produced.")
            if self._bytes + len(raw) > config.MAX_OUTPUT_BYTES:
                raise RunError("The output files exceed the permitted total size.")
            self._names.add(name)
            self._bytes += len(raw)
        self._on_file({"type": "file", "name": name, "content": text, "encoding": encoding})
        return name
