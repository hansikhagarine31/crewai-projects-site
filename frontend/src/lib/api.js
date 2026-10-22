export class ApiError extends Error {
  /**
   * @param {number} status  HTTP status, or 0 when the server could not be reached.
   * @param {string} message A message suitable for display.
   * @param {{ retryAfter?: number | null, code?: string, details?: unknown }} [extra]
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = extra.retryAfter ?? null;
    this.code = extra.code;
    this.details = extra.details;
  }
}

/** Parses a Retry-After header (seconds or an HTTP date) into seconds, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

async function request(path, options) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body (for example a proxy error); handled by the caller.
  }
  return { ok: response.ok, status: response.status, body, headers: response.headers };
}

function failure(result, fallback) {
  const error = result.body?.error;
  return new ApiError(result.status, error?.message ?? fallback, {
    retryAfter: parseRetryAfter(result.headers?.get('retry-after')),
    code: error?.code,
    details: error?.details,
  });
}

async function attempt(path, options, fallback) {
  try {
    return await request(path, options);
  } catch {
    throw new ApiError(0, fallback);
  }
}

export async function getHealth() {
  try {
    return await request('/api/health');
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** Creates a run and returns { runId, awaitingFiles }. Throws ApiError. */
export async function startRun(projectId, inputs, files) {
  const result = await attempt(
    `/api/projects/${encodeURIComponent(projectId)}/runs`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs, files }) },
    'The server could not be reached.',
  );
  if (!result.ok) throw failure(result, 'The run could not be started.');
  return result.body;
}

/** Uploads one file for a run that is waiting for files. Throws ApiError. */
export async function uploadFile(runId, field, file) {
  const form = new FormData();
  form.append('field', field);
  form.append('file', file, file.name);
  const result = await attempt(`/api/runs/${encodeURIComponent(runId)}/uploads`, { method: 'POST', body: form }, 'The server could not be reached.');
  if (!result.ok) throw failure(result, 'The file could not be uploaded.');
  return result.body;
}

/** Best effort: releases a run that will not be completed. Never throws. */
export async function cancelRun(runId) {
  try {
    await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  } catch {
    // The run expires by itself.
  }
}

/**
 * Looks up a run's result.
 * kind: 'final' (body holds the result), 'pending' (still running, or waiting with its `review`), 'missing' (expired or unknown),
 * 'unreachable' (the server could not be reached).
 */
export async function getResult(runId) {
  let result;
  try {
    result = await request(`/api/runs/${encodeURIComponent(runId)}/result`);
  } catch {
    return { kind: 'unreachable' };
  }
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 202) return { kind: 'pending', status: result.body?.status ?? 'running', review: result.body?.review ?? null };
  if (!result.ok || !result.body) return { kind: 'unreachable' };
  return { kind: 'final', body: result.body };
}

/**
 * Fetches the draft of a run that is waiting for a decision.
 * kind: 'ok' (review), 'not-waiting' (the run has moved on), 'missing', 'unreachable'.
 */
export async function getReview(runId) {
  let result;
  try {
    result = await request(`/api/runs/${encodeURIComponent(runId)}/review`);
  } catch {
    return { kind: 'unreachable' };
  }
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 409) return { kind: 'not-waiting' };
  if (!result.ok || !result.body?.review) return { kind: 'unreachable' };
  return { kind: 'ok', review: result.body.review };
}

/** Sends the reviewer's decision: 'approved', or 'revise' with feedback. Throws ApiError. */
export async function submitDecision(runId, decision, feedback) {
  const result = await attempt(
    `/api/runs/${encodeURIComponent(runId)}/decision`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, feedback }) },
    'The server could not be reached.',
  );
  if (!result.ok) throw failure(result, 'The decision could not be sent.');
  return result.body;
}
