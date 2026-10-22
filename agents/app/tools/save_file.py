from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from app.outputs import OutputCollector
from app.errors import RunError


class SaveFileInput(BaseModel):
    name: str = Field(..., max_length=100, description="File name, for example report.md.")
    content: str = Field(..., description="The full text of the file.")


class SaveOutputFileTool(BaseTool):
    """Registers an output file with the run. Nothing is written to disk."""

    name: str = "Save output file"
    description: str = "Saves a text file as an output of this run so that the user can download it."
    args_schema: type[BaseModel] = SaveFileInput
    collector: OutputCollector

    model_config = {"arbitrary_types_allowed": True}

    def _run(self, name: str, content: str) -> str:
        try:
            saved = self.collector.add_file(name, content)
        except RunError as error:
            return f"The file was not saved: {error}"
        return f"Saved {saved}."


def make_save_file_tool(collector: OutputCollector) -> SaveOutputFileTool:
    return SaveOutputFileTool(collector=collector)
