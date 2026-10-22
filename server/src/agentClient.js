import path from 'node:path';
import { STATUSES, nodeIdsOf } from './projects.js';

const CONTENT_TYPES = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function contentTypeFor(name) {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Reduces a file name from the agents service to a safe single path segment. */
export function safeFileName(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return null;
  return base;
}

/**
 * Builds a contract event from a line of agent output, or returns null when it
 * does not satisfy the contract { runId, nodeId, status, message, ts }.
 */
export function toContractEvent(raw, { runId, nodeIds }) {
  if (!raw || typeof raw !== 'object') return null;
  if (!nodeIds.has(raw.nodeId) || !STATUSES.includes(raw.status)) return null;
  return {
    runId,
    nodeId: raw.nodeId,
    status: raw.status,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 1000) : '',
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
  };
}

/** Yields complete lines from a byte stream, failing if a line exceeds maxLine characters. */
async function* readLines(body, maxLine) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
    }
    if (buffer.length > maxLine) throw new Error('Agent output line exceeds the permitted size.');
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer.trim();
}

/**
 * Sends one part of a run to the agents service and applies its newline-delimited JSON stream to the run
 * registry. Resolves when the part has ended: the run is then finished, or waiting for a decision.
 *
 * Line types: { type: "event", runId, nodeId, status, message, ts },
 * { type: "result", markdown }, { type: "file", name, content, encoding: "utf-8" | "base64" },
 * { type: "error", message }, { type: "waiting", message, review: {...} }.
 * `request` is { path, payload }. A part that was refused with status 410 (the stored draft has
 * expired) or 404 (it no longer exists) is reported as such.
 */
async function streamPart({ project, runId, request, registry, config, fetchImpl, log }) {
  const run = registry.get(runId);
  const nodeIds = nodeIdsOf(project);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.agentTimeoutMs);
  const onCancel = () => controller.abort();
  run.abort.signal.addEventListener('abort', onCancel, { once: true });
  if (run.abort.signal.aborted) controller.abort();

  let gotResult = false;
  let review = null;
  let agentError = null;
  let fatal = null;

  try {
    const response = await fetchImpl(`${config.agentsUrl}${request.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-ndjson',
        'x-agent-secret': config.agentSecret,
      },
      body: JSON.stringify(request.payload),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      log.error(`Agents service returned status ${response.status} for run ${runId}.`);
      if (response.status === 410) registry.finish(runId, 'expired', 'The report was not reviewed within 30 minutes, so the run has ended and the draft has been deleted.');
      else if (response.status === 404 && request.resume) registry.finish(runId, 'error', 'The stored draft is no longer available.');
      else registry.finish(runId, 'error', `The agents service refused the run (status ${response.status}).`);
      return;
    }

    for await (const line of readLines(response.body, config.maxOutputBytes * 2)) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log.warn(`Run ${runId}: ignored a line that is not valid JSON.`);
        continue;
      }

      if (message.type === 'event') {
        const event = toContractEvent(message, { runId, nodeIds });
        if (event) registry.emit(runId, event);
        else log.warn(`Run ${runId}: ignored an event that breaks the contract.`);
      } else if (message.type === 'result') {
        if (typeof message.markdown !== 'string') {
          log.warn(`Run ${runId}: ignored a result without Markdown.`);
          continue;
        }
        registry.setResult(runId, { markdown: message.markdown });
        gotResult = true;
      } else if (message.type === 'file') {
        const name = safeFileName(message.name);
        if (!name || typeof message.content !== 'string') {
          log.warn(`Run ${runId}: ignored a file with an unusable name or content.`);
          continue;
        }
        const content = Buffer.from(message.content, message.encoding === 'base64' ? 'base64' : 'utf8');
        try {
          registry.addFile(runId, name, { content, contentType: contentTypeFor(name) });
        } catch (error) {
          fatal = error.message;
          controller.abort();
          break;
        }
      } else if (message.type === 'waiting') {
        if (message.review && typeof message.review === 'object' && typeof message.review.draft === 'string') review = message.review;
        else log.warn(`Run ${runId}: ignored a waiting marker without a draft.`);
      } else if (message.type === 'error') {
        agentError = typeof message.message === 'string' ? message.message.slice(0, 500) : 'The run failed.';
      }
    }

    if (fatal) registry.finish(runId, 'error', fatal);
    else if (agentError) registry.finish(runId, 'error', agentError);
    else if (review) registry.setWaiting(runId, review);
    else if (gotResult) registry.finish(runId, 'done');
    else registry.finish(runId, 'error', 'The agents service ended the stream before returning a result.');
  } catch (error) {
    if (fatal) {
      registry.finish(runId, 'error', fatal);
    } else if (run.abort.signal.aborted) {
      registry.finish(runId, 'cancelled');
    } else if (timedOut) {
      registry.finish(runId, 'error', 'The run exceeded the permitted time.');
    } else {
      log.error(`Run ${runId}: ${error.cause?.code ?? error.message}`);
      registry.finish(runId, 'error', 'The connection to the agents service was lost.');
    }
  } finally {
    clearTimeout(timer);
    run.abort.signal.removeEventListener('abort', onCancel);
  }
}

/** Starts a run on the agents service. */
export function startRun({ project, runId, inputs, registry, config, fetchImpl = fetch, log = console }) {
  const request = { path: `/run/${encodeURIComponent(project.id)}`, payload: { runId, inputs } };
  return streamPart({ project, runId, request, registry, config, fetchImpl, log });
}

/** Continues a waiting run with a decision; the new events go into the same run. */
export function resumeRun({ project, runId, decision, feedback, registry, config, fetchImpl = fetch, log = console }) {
  const request = { path: `/resume/${encodeURIComponent(runId)}`, payload: { decision, feedback }, resume: true };
  return streamPart({ project, runId, request, registry, config, fetchImpl, log });
}

/** Asks the agents service to delete the stored state of a run. Harmless if there is none. */
export async function discardState({ runId, config, fetchImpl = fetch, log = console }) {
  try {
    await fetchImpl(`${config.agentsUrl}/state/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      headers: { 'x-agent-secret': config.agentSecret },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    log.warn(`Run ${runId}: the stored state could not be deleted (${error.cause?.code ?? error.message}).`);
  }
}
