# Build from the repository root: docker build -f agents/Dockerfile .
# The service reads shared/projects.json, which is two directories above agents/app.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

WORKDIR /srv/agents
COPY agents/requirements.txt ./
RUN pip install -r requirements.txt

COPY agents/app ./app
COPY agents/config ./config
COPY shared/projects.json /srv/shared/projects.json

# Waiting runs are stored here, on a volume, and deleted after 30 minutes.
RUN useradd --create-home --uid 10001 agents && mkdir -p /var/lib/agents/state && chown agents /var/lib/agents/state
USER agents

ENV AGENT_HOST=0.0.0.0 AGENT_PORT=8001 REVIEW_STATE_DIR=/var/lib/agents/state
EXPOSE 8001
CMD ["python", "-m", "app.main"]
