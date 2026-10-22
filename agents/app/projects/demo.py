"""The demonstration project: exercises the whole pipeline without calling Gemini."""
import time

from app.events import Emitter

STEP_DELAY_SECONDS = 0.4

_STEPS = [
    ("topic", "Topic received"),
    ("plan", "Outline prepared"),
    ("research", "Sources reviewed"),
    ("compose", "Draft composed"),
]


def run(emitter: Emitter, inputs: dict) -> str:
    topic = str(inputs.get("topic", "")).strip()
    notes = inputs.get("notes") or []
    # Uploaded text is data: only its length is used here, never its content as instructions.
    characters = sum(len(str(item.get("content", ""))) for item in notes)
    notes_line = f"Notes received: {characters} characters.\n\n" if notes else ""

    for node_id, done_message in _STEPS:
        emitter.emit(node_id, "running", f"Working on {node_id}")
        time.sleep(STEP_DELAY_SECONDS)
        emitter.emit(node_id, "done", done_message)

    emitter.emit("demo_md", "running", "Writing demo.md")
    markdown = (
        "# Demonstration result\n\n"
        f"Topic: {topic}\n\n"
        f"{notes_line}"
        "This text was produced by the demonstration project. No language model was called.\n"
    )
    emitter.outputs.add_file("demo.md", markdown)
    time.sleep(STEP_DELAY_SECONDS)
    emitter.emit("demo_md", "done", "demo.md saved")
    return markdown
