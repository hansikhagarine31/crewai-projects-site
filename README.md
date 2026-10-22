# CrewAI Projects Site

A website that runs ten CrewAI projects live. See `CLAUDE.md` for the standing rules.

| Part | Technology | Address |
|------|------------|---------|
| `frontend/` | React (Vite) | http://localhost:5173 |
| `server/` | Node.js, Express | http://localhost:8000 |
| `agents/` | Python 3.11, FastAPI, CrewAI | http://127.0.0.1:8001 (internal) |

## Setup

1. `agents/`: `py -3.11 -m venv .venv`, then `.venv\Scripts\pip install -r requirements.txt`. Copy `.env.example` to `.env`.
2. `server/`: `npm install`. Copy `.env.example` to `.env`.
3. `frontend/`: `npm install`.

`AGENT_SHARED_SECRET` must be identical in `agents/.env` and `server/.env`. The Gemini key belongs only in `agents/.env`.

## Start

Run each in its own terminal, agents first.

```
cd agents   && .venv\Scripts\python -m app.main
cd server   && npm start
cd frontend && npm run dev
```

## Verify

Open http://localhost:5173. The home page reports "Server connected, agents connected" when the chain works. If the agents service is stopped, it names the unreachable part.

## Server tests

```
cd server && npm test
```

To exercise the server without the Python service, run `node test/fakeAgent.js` in `server/` (listens on port 8001
with the secret from `AGENT_SHARED_SECRET`). The agents protocol is in `shared/agent-protocol.md`.

## Agents tests

```
cd agents && .venv\Scripts\pip install -r requirements-dev.txt && .venv\Scripts\python -m pytest
```

Check the stream directly (agents service running; `$SECRET` is `AGENT_SHARED_SECRET`):

```
curl -N -X POST 127.0.0.1:8001/run/demo -H "content-type: application/json" -H "x-agent-secret: $SECRET" -d '{"runId":"11111111-2222-3333-4444-555555555555","inputs":{"topic":"test"}}'
```

## Frontend tests

```
cd frontend && npm test
```

Vitest runs the data and layout checks (against `shared/projects.json` and `design/reference.html`) and the
component tests (React Testing Library). To try the whole pipeline in a browser without Gemini, start the three
parts and open http://localhost:5173/projects/demo.

## Lead scoring criteria

The criteria, weights and hot/warm thresholds for project 9 are in `agents/config/lead_scoring.yaml`, with comments
explaining each setting. The file is read at the start of every run, so a change applies to the next run without a
restart. Set `LEAD_SCORING_CONFIG` to use a different file.

## Tests, contract and Docker

- `npm test` at the repository root runs the contract test, then the server, frontend and agents suites.
- The contract test (`contract/`) compares the node ids in `shared/projects.json`, `frontend/src/data/projects.js` and the events the Python runners emit. The emitted events are recorded in `shared/event-logs/` while the agents tests run; rewrite them with `RECORD_EVENTS=1` set when running the whole agents suite (`cd agents && RECORD_EVENTS=1 .venv/Scripts/python -m pytest`) after changing a project's nodes.
- `docker compose up --build` runs `server/` and `agents/` (see the comments in `docker-compose.yml`). The agents service publishes no port and shares only an internal network with the server.
