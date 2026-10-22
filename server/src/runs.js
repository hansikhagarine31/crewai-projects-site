import { randomUUID } from 'node:crypto';

export const TERMINAL = new Set(['done', 'error', 'cancelled', 'expired']);

/**
 * In-memory registry of runs.
 * Run status: awaiting_upload | running | waiting | done | error | cancelled | expired.
 * A waiting run is paused for a person's decision. It is not counted as active, and it expires after waitingTtlMs.
 * Each stored event has a monotonically increasing `seq`, used as the SSE event id.
 */
export function createRunRegistry({
  runTtlMs = 30 * 60 * 1000,
  awaitingUploadTtlMs = 10 * 60 * 1000,
  waitingTtlMs = 30 * 60 * 1000,
  maxEventsPerRun = 500,
  maxOutputBytes = 5 * 1024 * 1024,
  now = Date.now,
  onFinish = () => {},
} = {}) {
  const runs = new Map();
  const subscribers = new Map();

  const must = (runId) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    return run;
  };

  const notify = (runId, message) => {
    for (const listener of subscribers.get(runId) ?? []) listener(message);
  };

  function createRun(projectId, inputs, { status = 'running', cached = false, meta = {} } = {}) {
    const runId = randomUUID();
    runs.set(runId, {
      runId,
      projectId,
      inputs,
      status,
      cached,
      meta,
      events: [],
      nextSeq: 1,
      result: null,
      error: null,
      review: null,
      waitingSince: null,
      hasState: false,
      files: Object.create(null),
      outputBytes: 0,
      createdAt: now(),
      finishedAt: null,
      abort: new AbortController(),
    });
    return runId;
  }

  const get = (runId) => runs.get(runId);

  function setStatus(runId, status) {
    must(runId).status = status;
  }

  function setInputs(runId, inputs) {
    must(runId).inputs = inputs;
  }

  /** A cached replay does not use the agents service, so it is not counted as active. */
  function setCached(runId) {
    must(runId).cached = true;
  }

  /** Appends an event, trims history to the cap and notifies subscribers. */
  function emit(runId, event) {
    const run = must(runId);
    const entry = { seq: run.nextSeq++, event };
    run.events.push(entry);
    if (run.events.length > maxEventsPerRun) run.events.splice(0, run.events.length - maxEventsPerRun);
    notify(runId, { type: 'event', entry });
    return entry;
  }

  function setResult(runId, result) {
    must(runId).result = result;
  }

  function addFile(runId, name, { content, contentType }) {
    const run = must(runId);
    const previous = run.files[name]?.size ?? 0;
    if (run.outputBytes - previous + content.length > maxOutputBytes) {
      throw new Error('Output files exceed the permitted total size.');
    }
    run.outputBytes += content.length - previous;
    run.files[name] = { name, contentType, size: content.length, content };
  }

  /** Pauses the run for a decision. `review` is what the person needs to see (the draft and the limits). */
  function setWaiting(runId, review) {
    const run = must(runId);
    if (TERMINAL.has(run.status)) return;
    run.status = 'waiting';
    run.review = review;
    run.waitingSince = now();
    run.hasState = true;
    // The deadline shown to the person is this server's own, so that both sides expire the run together.
    run.review.expiresAt = run.waitingSince + waitingTtlMs;
    notify(runId, { type: 'waiting' });
  }

  /** Takes a waiting run for resuming. Only one caller can succeed; returns false for everyone else. */
  function claimWaiting(runId) {
    const run = must(runId);
    if (run.status !== 'waiting') return false;
    run.status = 'running';
    run.review = null;
    run.waitingSince = null;
    return true;
  }

  /**
   * A run that ends without completing must not leave a node "running" or "waiting" in the diagram. The agents service
   * already marks its active nodes as failed when it fails; this covers the ends that it cannot report (a cancelled
   * run, a lost connection, a timeout, an expired wait). A node that was working is "error" when the run failed and
   * "skipped" when it was cancelled or expired.
   */
  function settleActiveNodes(run, status, error) {
    const settled = status === 'error' ? 'error' : status === 'cancelled' || status === 'expired' ? 'skipped' : null;
    if (!settled) return;
    const latest = new Map();
    for (const { event } of run.events) latest.set(event.nodeId, event.status);
    const message = (error ?? (status === 'cancelled' ? 'The run was cancelled.' : 'The run ended.')).slice(0, 1000);
    for (const [nodeId, nodeStatus] of latest) {
      if (nodeStatus === 'running' || nodeStatus === 'waiting') emit(run.runId, { runId: run.runId, nodeId, status: settled, message, ts: now() });
    }
  }

  /** Marks the run as finished and tells subscribers to close. Idempotent. */
  function finish(runId, status, error = null) {
    const run = must(runId);
    if (TERMINAL.has(run.status)) return;
    settleActiveNodes(run, status, error);
    run.status = status;
    run.error = error;
    run.finishedAt = now();
    run.review = null;
    run.waitingSince = null;
    notify(runId, { type: 'end', status });
    onFinish(run);
  }

  function subscribe(runId, listener) {
    if (!subscribers.has(runId)) subscribers.set(runId, new Set());
    subscribers.get(runId).add(listener);
    return () => {
      const set = subscribers.get(runId);
      set?.delete(listener);
      if (set?.size === 0) subscribers.delete(runId);
    };
  }

  const countActive = () => [...runs.values()].filter((run) => run.status === 'running' && !run.cached).length;

  /** Cancels uploads that were never completed and drops expired finished runs. */
  function sweep() {
    const time = now();
    for (const run of [...runs.values()]) {
      if (run.status === 'awaiting_upload' && time - run.createdAt > awaitingUploadTtlMs) {
        finish(run.runId, 'cancelled', 'The upload window expired.');
      }
      if (run.status === 'waiting' && time - run.waitingSince >= waitingTtlMs) {
        finish(run.runId, 'expired', 'The report was not reviewed within 30 minutes, so the run has ended and the draft has been deleted.');
      }
      if (run.finishedAt !== null && time - run.finishedAt > runTtlMs) {
        runs.delete(run.runId);
        subscribers.delete(run.runId);
      }
    }
  }

  function startSweeper(intervalMs = 60 * 1000) {
    const timer = setInterval(sweep, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { createRun, get, setStatus, setInputs, setCached, setWaiting, claimWaiting, emit, setResult, addFile, finish, subscribe, countActive, sweep, startSweeper };
}
