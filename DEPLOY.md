# Deployment

This document describes how to publish the site: the frontend on Vercel, and the server and the agents service on Render, all on free plans. The steps are in the order in which they must be carried out. Statements about the hosts come from their documentation as it stood on 22 October 2026; where a statement could not be verified, it is marked as such. Check the pages named in the text before relying on them, because free plans change.

## 1. Summary

| Part | Host | Plan | Address variable |
| --- | --- | --- | --- |
| `frontend/` | Vercel | Hobby | `VITE_API_BASE_URL` (set when the site is built) |
| `server/` | Render, web service | Free | `ALLOWED_ORIGIN`, `AGENT_BASE_URL` |
| `agents/` | Render, web service | Free | none |

The browser talks to the site on Vercel for the pages and directly to the server on Render for the API and the event stream. The server talks to the agents service. The agents service alone holds the Gemini key.

### Recommendation

Use Render for both backend services and Vercel for the frontend.

- Render builds the existing Dockerfiles without change and has a free plan for web services. A single Blueprint file, `render.yaml`, describes both services.
- Vercel serves a static build, which its free Hobby plan is intended for. The browser connects to Render directly. A rewrite through Vercel is deliberately not used, because it would place a second proxy, with its own limits, in the path of the event stream.

### Cold-start behaviour on Render's free plan

From Render's documentation ("Free web services"):

- A service that receives no inbound request for 15 minutes is stopped. It starts again on the next request, which takes about one minute; a browser shows a loading page meanwhile.
- Each workspace has 750 free instance hours a month. Time spent stopped does not count. When the hours are used, free web services are suspended until the next month. Two services that were both running all month would need about 1,488 hours, so they cannot both stay awake continuously on one workspace.
- The file system is ephemeral: changes are lost on every redeploy, restart and stop.
- The documentation does not state the memory of a free instance; Render's compute-plan and pricing pages list 512 MB of memory and 0.1 CPU. The agents service used about 228 MB after start-up and about 285 MB after one run that failed at the model call (measured on Windows; not measured on Render). A run that completes may use more. If the host reports an out-of-memory restart, the agents service needs a paid plan.

What a visitor experiences after a quiet period: the first request waits about a minute for the server. The first run then waits a further minute for the agents service to start, because the server only contacts it when a run begins. The home page's connection indicator calls `/api/health`, which also reaches the agents service, so opening the home page starts both services before the visitor begins a run.

### Keeping the agents service private

The agents service must be reachable only by the server. The options are:

1. **Private networking.** The service has no public address and the server reaches it by an internal name. This is how `docker-compose.yml` works locally (the `backend` network is internal and the agents service publishes no port). On Render, a free web service cannot receive private-network traffic (Render documentation, "Private network"), so this option is not available on the free plan. Render's private service type is the equivalent; I did not find a free plan for it in the documentation consulted, so treat it as paid unless Render's pricing page says otherwise.
2. **Public address, secret enforced.** The service is reachable from the internet, and every route except `/health` rejects a request that lacks the correct `x-agent-secret` header. This is what the free Render plan allows, and it is what `render.yaml` configures.

Other free hosts, as far as could be established:

| Host | Private networking | Free use for a new account |
| --- | --- | --- |
| Fly.io | Yes (private network between apps of one organisation) | No free allowance for new organisations; a short trial only (third-party sources; confirm at fly.io/pricing). |
| Google Cloud Run | Yes (ingress restricted to internal traffic or to authenticated callers) | A monthly free allowance exists but needs a billing account. Calling a service that requires authentication needs Google identity tokens, which the server does not implement. |
| Hugging Face Spaces | Not applicable | Documentation states that Spaces running Docker require a paid plan. Not suitable. |

None of these is configured here. For a deployment that is private by construction, run the two backend services with `docker compose` on a machine you control (see the README), or move the agents service to a paid private service.

With option 2, the protection rests on four measures that are all in the code and covered by tests:

- The secret is compared in constant time, and every route except `/health` refuses a request without it (`agents/tests/test_security.py` walks the registered routes).
- The interactive documentation and the schema (`/docs`, `/redoc`, `/openapi.json`) are not served.
- The service refuses every request, with status 503, if no secret is configured.
- The secret must be long and random (step 3). A secret of 32 random bytes cannot be guessed.

The residual risk is that anyone who obtains the secret can spend your Gemini quota. Keep the secret only in the two hosts' environment settings, and rotate it as described in section 11.

## 2. Before you begin

Accounts: GitHub (the repository is at `https://github.com/hansikhagarine31/crewai-projects-site`), Google AI Studio, Render and Vercel.

1. Run the whole test suite from the repository root and confirm it passes:

   ```
   npm test
   ```

   It begins with a search of the repository and of any built frontend for key patterns, then runs the contract test and the server, frontend and agents suites.

2. Confirm that the changes are committed and pushed to `main`. Render and Vercel build from the repository, not from your machine.

## 3. Create the secrets

1. In Google AI Studio, create a Gemini API key. Do not paste it into any chat, issue or file in the repository.
2. Check the model and the limits that apply to you:
   - The model name is a single constant, `DEFAULT_GEMINI_MODEL` in `agents/app/config.py`, currently `gemini-3.5-flash-lite`. Google's model list shows this identifier with the status "Stable". The page does not say whether it is available on the free tier. Open `https://aistudio.google.com/rate-limit` to see the limits that apply to your project; limits are applied per project, not per key, and the daily quota resets at midnight Pacific time.
   - To change the model without editing the code, set `GEMINI_MODEL` on the agents service.
3. Generate the shared secret. Run this once and keep the output for step 4 and step 5:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

## 4. Deploy the agents service on Render

Using the Blueprint (recommended): in the Render dashboard choose **New**, then **Blueprint**, connect the GitHub repository, and accept `render.yaml`. Render asks for the values marked `sync: false`. Enter:

| Service | Variable | Value |
| --- | --- | --- |
| `crewai-agents` | `GEMINI_API_KEY` | the key from step 3 |
| `crewai-agents` | `AGENT_SHARED_SECRET` | the secret from step 3 |

For `crewai-server`, enter the same secret as `AGENT_SHARED_SECRET`. For `AGENT_BASE_URL` and `ALLOWED_ORIGIN`, whose true values are not yet known, enter the placeholder `https://placeholder.invalid`; step 5 and step 7 replace it. The server cannot work until they are replaced.

Without the Blueprint: create a **Web Service** from the repository with the runtime **Docker**, the plan **Free**, the Dockerfile path `./agents/Dockerfile`, the Docker build context `.` (the repository root, because the image copies `shared/projects.json`), and the health check path `/health`.

After the deployment, note the public address (for example `https://crewai-agents.onrender.com`; Render adds a suffix if the name is taken). Open `<address>/health`. The expected answer is `{"status":"ok"}`. Open `<address>/docs`: the expected answer is a 404 or a 401, never a page.

Environment variables of the agents service:

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | The key. Present only on this service. |
| `AGENT_SHARED_SECRET` | yes | Must equal the server's value. |
| `GEMINI_MODEL` | no | Overrides the model constant. |
| `PORT` | set by Render | The service listens on it (`AGENT_PORT` takes precedence when set). |

## 5. Deploy the server on Render

Set these variables on `crewai-server`:

| Variable | Value |
| --- | --- |
| `AGENT_BASE_URL` | The public address of the agents service from step 4, without a trailing slash (replaces the placeholder). |
| `AGENT_SHARED_SECRET` | The same secret as the agents service. |
| `ALLOWED_ORIGIN` | The address of the site on Vercel. Not known yet: leave the placeholder and replace it in step 7. |
| `RATE_LIMIT` | Runs that one address may start per hour. `render.yaml` sets `20`. Gemini's own quota is the real limit; raising this number does not raise it. |
| `AGENT_TIMEOUT_MS` | The longest a run may take, in milliseconds. `render.yaml` sets `900000` (15 minutes). A free instance has 0.1 CPU, the agents service may first need about a minute to start, and a rate-limited model call waits and retries, so the earlier limit of 5 minutes was too short for some projects. |
| `TRUST_PROXY` | `1` (set by `render.yaml`). See the note below. |

The server refuses to start in production if the secret is missing, if `ALLOWED_ORIGIN` is `*`, or if `AGENT_BASE_URL` has no `http://` or `https://`. The Render log then shows the reason.

Save, let the service deploy, and note its address (for example `https://crewai-server.onrender.com`). Open `<address>/api/health`. The expected answer is `{"server":"ok","agents":"ok"}`. The first answer after a quiet period can take about a minute, and may show `"agents":"unreachable"` while the agents service starts; repeat after a minute.

**Client addresses and `TRUST_PROXY`.** The run limit is applied per client address. Behind Render's proxy, the server sees the proxy's address unless it is told how many proxies to trust. With `TRUST_PROXY=1` it uses the address that the nearest proxy appended to `X-Forwarded-For`. Reports from Render users say that Render appends to that header and does not reset it; I could not find this stated in Render's own documentation, so verify it (section 7, check 6). A value of `true` must not be used: it trusts the whole header, which a client can write.

## 6. Deploy the frontend on Vercel

1. In Vercel choose **Add New**, then **Project**, and import the repository.
2. Leave **Root Directory** as the repository root. `vercel.json` at the root installs and builds `frontend/` and publishes `frontend/dist`. The root is required because the sample inputs are read from `shared/samples`, which lies outside `frontend/`.
3. Add the environment variable `VITE_API_BASE_URL` with the server address from step 5, without a trailing slash, for the Production environment. The value is read when the site is built and ends up in the public bundle, so it must never be a secret. After any change to it, redeploy.
4. Deploy and note the address (for example `https://crewai-projects-site.vercel.app`).

`vercel.json` also sends every path to `index.html` so that a refreshed project page works, caches the hashed assets for a year, and sets `X-Content-Type-Options`, `Referrer-Policy` and a limited `Content-Security-Policy` (`base-uri`, `object-src`, `form-action`, `frame-ancestors`). A full script policy is not set; it would need the server address to be known when the file is written.

## 7. Connect the site to the server, then verify

1. In Render, set `ALLOWED_ORIGIN` on `crewai-server` to the exact address from step 6: scheme and host, no path and no trailing slash. Several addresses (for example a custom domain as well) may be given, separated by commas. A trailing slash is removed automatically, because a browser never sends one. Preview deployments on Vercel have different addresses and are refused unless listed.
2. Wait for the server to redeploy.

Checks, in this order:

1. **Health.** Open the site's home page. The line under the introduction must read "Server connected, agents connected". "Server unreachable" usually means `VITE_API_BASE_URL` is wrong or `ALLOWED_ORIGIN` does not match.
2. **A run.** Open the demonstration project at `/projects/demo`, choose **Sample input**, and run it. Every step must turn done in sequence, and `demo.md` must be offered for download. This calls no language model.
3. **A model run.** Run a real project, for example the blog post crew, with **Sample input**. A message that the language model is not configured means `GEMINI_API_KEY` is missing on the agents service. A message about a rate limit comes from Gemini's own quota.
4. **Cancel.** Start a run and choose **Cancel run**. The run must report as cancelled and **Run** must become available again.
5. **Streaming** (section 8).
6. **Client addresses.** From one network, start more runs than `RATE_LIMIT` allows: the next attempt must be refused with the message about the limit. Then, from a different network (for example mobile data), start a run: it must be accepted. If the second network is also refused, the server is counting the proxy's address; read the Render log for `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` (the value is too low, or zero) or `ERR_ERL_PERMISSIVE_TRUST_PROXY` (it is too permissive), and adjust `TRUST_PROXY`.
7. **Cross-origin refusal.** `curl -i -H "Origin: https://example.org" <server>/api/projects` must not return `Access-Control-Allow-Origin: https://example.org`. With a single allowed origin, the header names that origin whatever the caller sends, so a browser on any other site refuses the response.
8. **Agents refuse strangers.** `curl -i <agents>/run/demo -X POST` must return 401.

## 8. Event streaming through the host's proxy

The browser follows each run over server-sent events. A proxy that holds back the response until it ends would show every step at once at the end. The server therefore sends, on `/api/runs/:runId/events`:

- `Content-Type: text/event-stream`;
- `Cache-Control: no-cache, no-transform`, which also forbids compression and other transformation;
- `X-Accel-Buffering: no`, the header that nginx-type proxies honour to disable buffering;
- `Connection: keep-alive`, and headers sent at once (`flushHeaders`) followed by a first event;
- a named `heartbeat` event and a comment line every 15 seconds, so that an idle connection is not closed and the browser can notice a dead one.

The agents service sets `X-Accel-Buffering: no` on its own stream as well. No compression middleware is installed in either service. The headers are covered by `server/test/deployment.test.js`.

**How to verify on the deployed host.** Run, from any machine with Node 22:

```
node scripts/check-stream.mjs https://<server address> https://<site address>
```

The script starts a run of the demonstration project (no language model is called), reads the stream, and compares the time over which the events were emitted with the time over which they arrived. It prints PASS or FAIL for each of: the status, the content type, the absence of compression, `no-transform`, the CORS header, the number of events, and whether they arrived as they were emitted. Its exit status is 1 if any check fails. I verified that it passes against the local server and that it fails against a proxy that buffers the whole response.

A manual check is `curl -N -i <server>/api/runs/<runId>/events`: lines must appear while the run proceeds, and a `: heartbeat` line every 15 seconds.

I could not run these checks against Render itself. If the check fails there, the likely causes are, in order: a different proxy in front of Render (for example a corporate or custom-domain proxy that compresses), or a setting of the host's edge. Render's documentation states that messages on existing WebSocket connections keep a service awake; it says nothing about server-sent events, so whether an open event stream keeps the server awake is not established. The site does not rely on it (section 9).

## 9. What is lost when a service restarts or sleeps

Run state is held in memory in the server and, for project 10 only, on disk in the agents service. A free Render service restarts without notice, stops after 15 idle minutes, and loses its file system each time. Nothing is persisted across these events.

| What | Where | Lost when | What a visitor sees |
| --- | --- | --- | --- |
| Every run: its events, result and files | Server memory | The server restarts or stops | A page open on a run loses its event stream and, after a few failed reconnections, shows "The connection to the server was lost. The run may still be in progress or may have finished." **Reload result** then reports "The earlier run is no longer available. Results are kept only for a limited time." A download link opened afterwards returns "The run does not exist." |
| A run in progress | Server memory and a worker in the agents service | The server restarts | As above. The agents service stops the worker at its next step, because the server's request has ended. The visitor starts the run again. |
| A run in progress | Agents service | The agents service restarts | The run ends with an error: "The connection to the agents service was lost." The server itself is unaffected. |
| A draft waiting for review (project 10) | Agents service disk, and server memory | Either service restarts or stops | If the server restarted: the same message as for any run. If only the agents service restarted: the draft is still displayed, but approving or requesting a revision ends the run with the error "The stored draft is no longer available." The visitor starts again. |
| Results cached for an hour, so that a repeated request replays at once | Server memory | The server restarts | The run is computed again instead of replayed. |
| The run counters of `RATE_LIMIT` | Server memory | The server restarts | The counters start at zero, so the limit is not enforced across a restart. A restart is therefore a means of exceeding the limit; the agents' own quota at Gemini is the final limit. |
| Uploaded files awaiting a run (10 minutes) | Server memory | The server restarts | The upload is refused because the run no longer exists; the visitor submits the form again. |
| The last run's identifier | The visitor's browser (session storage) | The tab is closed | Nothing is recovered after a refresh in a new tab. This is not a restart effect. |

A draft that waits for review for up to 30 minutes is longer than the 15 minutes after which a free service stops if it receives no request. To prevent this, the page makes a small request to the server every four minutes while a draft is waiting (`KEEP_AWAKE_MS` in `frontend/src/hooks/useProjectRun.js`). The server's health check in turn reaches the agents service, so both stay awake while the tab is open. This is best effort: a browser may slow the timers of a tab in the background, and a closed tab stops them. A visitor who leaves the draft for more than 15 minutes with the tab closed will lose it, and will see the messages in the table above.

Consequences for the design of the deployment:

- Run only one instance of each service. The state is per process, so a second instance would not see the runs of the first.
- Do not treat a result as stored. The page tells the visitor that results are kept only for a limited time; the visitor should download files they need.

## 10. Security review

This review was made on 22 October 2026 against the code in the repository.

| Question | Finding | Evidence |
| --- | --- | --- |
| Does a secret appear in the repository? | No. No file, and no part of the Git history, matches the Google key pattern (`AIza` followed by 35 characters), common token formats, or a non-placeholder value for `AGENT_SHARED_SECRET` or `GEMINI_API_KEY`. No `.env` file is tracked. | `npm run check:secrets` (also the first step of `npm test`); `git log -p --all` searched for the key pattern: no match. |
| In the built frontend? | No. A production build made with `VITE_API_BASE_URL` set contains the server address once and none of: a key pattern, `x-agent-secret`, `AGENT_SHARED_SECRET`, `GEMINI_API_KEY`. Vite exposes only variables that begin with `VITE_`. | The same script scans `frontend/dist` when it exists, and any directory named on its command line. I confirmed that it fails when a key is planted in a bundle. |
| In the logs? | No. Both services were run with a key-shaped fake `GEMINI_API_KEY` and a fake secret, and a run was made to fail at the model call. Neither value appeared in the server log, the agents log or the events sent to the browser. As a second line of defence, the agents service now replaces key-shaped text and its own configured secrets in every log line, including tracebacks. | `agents/app/logredact.py`; `agents/tests/test_logredact.py`; a failed-run test with a secret-looking error (`agents/tests/test_failures.py`) confirms the visitor never sees raw error text. |
| Is CORS restricted? | Yes. Only the origin(s) in `ALLOWED_ORIGIN` are named in `Access-Control-Allow-Origin`; a wildcard is refused at start-up in production; a list answers only listed origins; preflight requests are answered the same way. Headers allowed: `content-type`, `last-event-id`. | `server/test/deployment.test.js` |
| Are uploads sandboxed? | Yes. Uploads are held in memory, never written to disk; one file of at most 2 MB per request; the extension must be on an allowlist (`.txt`, `.csv`, `.pdf`) and on the field's own list; the content signature is checked (PDF header, valid UTF-8 text with no null bytes); the name is reduced to a safe segment; text is extracted on the server so the agents service never receives a raw file; uploaded text is treated as data, never as instructions. | `server/src/uploads.js`, `server/src/extractText.js`; existing tests in `server/test/api.test.js` |
| Are downloads sandboxed? | Yes. Only names registered for that run are served (an exact lookup, so path segments give a 404); every file is sent as an attachment with `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store` and, through Helmet, `X-Content-Type-Options: nosniff`. The agents service writes nothing to disk except the review store, whose file names come from a validated identifier. Output file names are reduced to a single safe segment on both sides. | `server/src/routes/runs.js`, `agents/app/tools/save_file.py`, `agents/app/review_store.py` |
| Does the URL guard run in both Node and Python? | Yes. The server checks every URL input before a run starts (scheme, credentials, blocked host names, numeric forms, and every resolved address, including IPv6 mapped forms and cloud metadata addresses). The agents service checks again before any fetch, and checks every redirect hop. A shared list of 44 addresses (6 accepted, 38 rejected), `shared/url-guard-cases.json`, is run against both implementations, so they cannot drift apart. | `server/test/urlGuardParity.test.js`, `agents/tests/test_url_guard_parity.py` |
| Does every agent route except `/health` require the secret? | Yes. The check is a middleware on the whole application, so a route added later is covered. A test walks all registered routes, including the included router, and fails if any route other than `/health` answers without the correct header. | `agents/tests/test_security.py`, class `TestEveryRouteRequiresTheSecret` |

Changes made as a result of this review:

- The server's health report included the internal address of the agents service. It now says only that the service could not be reached.
- The agents service served interactive documentation and a schema. They are switched off.
- The server now refuses to start in production without a secret, with `*` as the allowed origin, or with an address that has no scheme.
- Trailing slashes in `ALLOWED_ORIGIN`, which would silently match nothing, are removed.
- Log redaction was added to the agents service.

Residual risks:

- **Rebinding between check and fetch.** The agents service resolves a host name to check it, and the scraping tool then resolves it again to fetch the page. An attacker who controls a host name's DNS could return a public address to the first lookup and a private one to the second. The addresses reachable from the agents service on Render are Render's own; there is no cloud metadata service reachable in the way a bare virtual machine has, but this is not verified. Closing the gap requires fetching by the checked address, which the scraping tool does not support.
- **Public agents service.** See section 1. The shared secret is the only barrier.
- **Rate limit is per process and per address.** It resets on restart (section 9) and does not distinguish visitors behind one shared address.
- **Content security policy.** The site's own policy is limited (section 6). Markdown from a model is rendered through a sanitising component that does not accept HTML; tests cover script and image injection in drafts and results.

## 11. Operations

- **Logs.** The Render dashboard shows each service's log. They contain run identifiers, status codes and plain messages; they do not contain inputs, keys or the secret.
- **Redeploying.** Each commit to `main` redeploys the services (`autoDeployTrigger: commit`). A redeploy is a restart: every run in progress and every waiting draft is lost (section 9). Deploy when nobody is using the site.
- **Rotating the shared secret.** Generate a new value (step 3). Set it on the agents service first, then on the server. Between the two changes every run fails with "The agents service refused the run (status 401)"; the interval is the time Render takes to restart one service.
- **Rotating the Gemini key.** Create a new key in Google AI Studio, set it on the agents service, then delete the old key in AI Studio.
- **Changing the model.** Set `GEMINI_MODEL` on the agents service, or change the constant and deploy.
- **Running locally.** `docker compose up --build` runs the two backend services on a private network (README). Docker is not installed on the development machine used to write this document; the Dockerfiles and the Compose file have not been built (section 12).

## 12. What has not been verified

- The Docker images have never been built, and neither has the Blueprint been applied: Docker is not installed on the machine where the work was done, and no Render or Vercel account was used. The layout the Dockerfiles create was simulated from a copy of the directories, and both services were run from it. The first deployment may expose an error in a Dockerfile or in `render.yaml`; the Render build log will show it.
- No run with a real Gemini key has been made. All model behaviour in the tests uses scripted stand-ins. Whether `gemini-3.5-flash-lite` is available on the free tier, and how many runs the free quota allows, must be read from Google AI Studio.
- The memory and speed of the agents service on a free instance (512 MB, 0.1 CPU) were not measured on Render.
- Whether Render's proxy buffers the event stream (section 8), and the number of proxies in front of the server (section 5), were not measured.
- Whether an open event stream keeps a free Render service awake is not established.
- The cross-origin behaviour (health, event stream, run, download) was verified in Chrome between two local origins with a production build, not between Vercel and Render.
