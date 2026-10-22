import logging

from crewai.tools import BaseTool
from pydantic import BaseModel, Field

from app import config
from app.untrusted import wrap_untrusted

log = logging.getLogger("agents.tools.web_search")

_TITLE_CHARS = 150
_SNIPPET_CHARS = 300


class WebSearchInput(BaseModel):
    query: str = Field(..., max_length=300, description="What to search the web for.")


def _search(query: str, max_results: int) -> list[dict]:
    from ddgs import DDGS  # imported here so the module loads without network libraries

    return DDGS().text(query, max_results=max_results)


class WebSearchTool(BaseTool):
    name: str = "Web search"
    description: str = (
        "Searches the web with DuckDuckGo and returns up to five results, each with a title, "
        "a URL and a short snippet. Use it to find sources; use the page reader to read one."
    )
    args_schema: type[BaseModel] = WebSearchInput

    def _run(self, query: str) -> str:
        try:
            results = _search(query, config.SEARCH_MAX_RESULTS)[: config.SEARCH_MAX_RESULTS]
        except Exception:  # noqa: BLE001 - a failed search must not stop the agent
            log.exception("Search failed")
            return "Search is temporarily unavailable."
        if not results:
            return "The search returned no results."

        lines = []
        for number, item in enumerate(results, start=1):
            title = str(item.get("title", ""))[:_TITLE_CHARS]
            url = str(item.get("href", ""))
            snippet = str(item.get("body", ""))[:_SNIPPET_CHARS]
            lines.append(f"{number}. {title}\n   {url}\n   {snippet}")
        return wrap_untrusted("a web search", "\n".join(lines))
