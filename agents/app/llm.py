from crewai import LLM

from app import config
from app.errors import RunError


def get_llm() -> LLM:
    """Returns the CrewAI LLM for the configured Gemini model.

    CrewAI's Gemini provider needs the `gemini/` prefix and the google-genai
    package (installed through the crewai[google-genai] extra).
    """
    if not config.GEMINI_API_KEY:
        raise RunError("The language model is not configured on the agents service.")
    return LLM(
        model=f"gemini/{config.GEMINI_MODEL}",
        api_key=config.GEMINI_API_KEY,
        max_output_tokens=config.LLM_MAX_OUTPUT_TOKENS,
    )
