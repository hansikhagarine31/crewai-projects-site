"""Runtime configuration for the agents service."""
import os

from dotenv import load_dotenv

load_dotenv()

# Single definition of the Gemini model name. Verify against the current
# Google AI Studio documentation before changing; override with GEMINI_MODEL.
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)
AGENT_SHARED_SECRET = os.getenv("AGENT_SHARED_SECRET", "")

HOST = os.getenv("AGENT_HOST", "127.0.0.1")
# Hosts such as Render give the port to listen on in PORT.
PORT = int(os.getenv("AGENT_PORT") or os.getenv("PORT") or "8001")

# While a run is silent (for example during a long model call) the stream sends a heartbeat line this often, so that
# no proxy or client timeout closes a connection that looks idle.
HEARTBEAT_SECONDS = float(os.getenv("HEARTBEAT_SECONDS", "10"))

# Limits. The server applies the same total output limit.
LLM_MAX_OUTPUT_TOKENS = int(os.getenv("LLM_MAX_OUTPUT_TOKENS", "8192"))
SEARCH_MAX_RESULTS = 5
SCRAPE_MAX_CHARS = int(os.getenv("SCRAPE_MAX_CHARS", "8000"))
SCRAPE_MAX_REDIRECTS = 5
MAX_OUTPUT_BYTES = int(os.getenv("MAX_OUTPUT_BYTES", str(5 * 1024 * 1024)))
MAX_OUTPUT_FILES = 10
MAX_RESULT_CHARS = int(os.getenv("MAX_RESULT_CHARS", "2000000"))

# A run that waits for a person is stored for this long, then deleted. Node uses the same period.
REVIEW_TTL_SECONDS = int(os.getenv("REVIEW_TTL_SECONDS", str(30 * 60)))
REVIEW_STATE_DIR = os.getenv("REVIEW_STATE_DIR", "")  # empty means agents/.state
MAX_REVISIONS = 3
