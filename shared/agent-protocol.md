# Protocol between server/ and agents/

The agents service must implement this exactly. `server/` is the only caller.

## Request

`POST {AGENTS_URL}/run/{projectId}` with headers `x-agent-secret: <AGENT_SHARED_SECRET>` and
`content-type: application/json`.

```json
{ "runId": "uuid", "inputs": { "topic": "text" } }
```

- Text fields are strings. `url` fields are strings that `server/` has already checked; `urls` fields are arrays of them.
- File fields are always arrays of `{ "filename", "contentType", "encoding", "content" }`.
  `encoding` is `utf8` for `.txt` and `.csv`, and `base64` for `.pdf`.
- All of it is untrusted data. It must never be placed in an agent's instructions.
- `server/` validates URLs when the run is created. The agents service must validate again before it fetches
  anything, including after redirects, because DNS answers can change.

## Response

`200` with `content-type: application/x-ndjson`: one JSON object per line, in any order, until the stream closes.

| Line | Meaning |
|------|---------|
| `{"type":"event","runId","nodeId","status","message","ts"}` | A node changed state: the event contract plus `type`. `nodeId` must be listed for the project in `shared/projects.json`; `status` must be one of the six permitted values; `ts` is milliseconds since the epoch. Lines that break this are discarded. |
| `{"type":"result","markdown":"..."}` | The final output. The run is `done` only if one is received. |
| `{"type":"file","name","content","encoding":"utf-8"\|"base64"}` | An output file. `server/` reduces `name` to `[A-Za-z0-9._-]` and chooses the content type from the extension. |
| `{"type":"error","message"}` | The run failed. The run is `error` and `message` is shown to the user, so it contains nothing sensitive. |

If the connection closes without a `result` or `error` line the run is recorded as failed.
When `server/` cancels a run or reaches its timeout it closes the connection; the agents service should stop work.

## Demonstration project

`demo` is internal and handled entirely by the agents service. Its nodes are `topic`, `plan`, `research`, `compose`
and `demo_md`. It takes one input, `topic`, and writes `demo.md`. It must not call Gemini.
