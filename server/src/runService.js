import { resumeRun as defaultResumeRun, startRun as defaultStartRun } from './agentClient.js';
import { cacheKey } from './cache.js';
import { HttpError } from './errors.js';

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Coordinates validation results, uploads, the cache and the agents service. */
export function createRunService({ registry, cache, config, getProject, startRun = defaultStartRun, resumeRun = defaultResumeRun, log = console }) {
  /** Replaces uploaded file contents with a summary so they can be freed after a run. */
  const stripFiles = (inputs) =>
    Object.fromEntries(
      Object.entries(inputs).map(([key, value]) => [
        key,
        Array.isArray(value) && (value[0]?.content !== undefined || value[0]?.text !== undefined)
          ? value.map((item) => ({ filename: item.filename ?? item.name, contentType: item.contentType }))
          : value,
      ]),
    );

  async function replayFromCache(runId, entry) {
    const run = registry.get(runId);
    for (const stored of entry.events) {
      await sleep(config.cacheReplayDelayMs, run.abort.signal);
      if (run.abort.signal.aborted) return registry.finish(runId, 'cancelled');
      registry.emit(runId, { ...stored, runId, ts: Date.now() });
    }
    for (const file of entry.files) registry.addFile(runId, file.name, file);
    registry.setResult(runId, entry.result);
    registry.finish(runId, 'done');
  }

  function remember(runId, key) {
    const run = registry.get(runId);
    const complete = run.nextSeq - 1 === run.events.length;
    const failed = run.events.some(({ event }) => event.status === 'error');
    if (run.status !== 'done' || !complete || failed) return;
    cache.set(key, {
      events: run.events.map(({ event }) => event),
      result: run.result,
      files: Object.values(run.files),
    });
  }

  /** Starts a run whose inputs are complete: replays from the cache or calls the agents service. */
  function begin(runId) {
    const run = registry.get(runId);
    const project = getProject(run.projectId);
    const key = cacheKey(project.id, run.inputs);
    const hit = project.cacheable ? cache.get(key) : undefined;

    if (hit) {
      registry.setCached(runId);
      registry.setStatus(runId, 'running');
      replayFromCache(runId, hit).catch((error) => {
        log.error(`Run ${runId}: cache replay failed (${error.message}).`);
        registry.finish(runId, 'error', 'The stored result could not be replayed.');
      });
      return;
    }

    if (registry.countActive() >= config.maxConcurrentRuns) {
      throw new HttpError(503, 'at_capacity', 'The service is running its maximum number of runs. Please try again shortly.');
    }

    registry.setStatus(runId, 'running');
    const inputs = run.inputs;
    startRun({ project, runId, inputs, registry, config, log })
      .then(() => remember(runId, key))
      .catch((error) => {
        log.error(`Run ${runId}: ${error.message}`);
        registry.finish(runId, 'error', 'The run could not be completed.');
      })
      .finally(() => registry.setInputs(runId, stripFiles(inputs)));
  }

  /** Creates a run from validated inputs. File inputs make it wait for uploads. */
  function submit(project, { inputs, expectedFiles }) {
    const waiting = Object.keys(expectedFiles).length > 0;
    const runId = registry.createRun(project.id, inputs, {
      status: 'awaiting_upload',
      meta: { expectedFiles, uploads: Object.fromEntries(Object.keys(expectedFiles).map((key) => [key, []])) },
    });
    if (!waiting) {
      try {
        begin(runId);
      } catch (error) {
        registry.finish(runId, 'cancelled', error.message);
        throw error;
      }
    }
    return { runId, awaiting: expectedFiles };
  }

  /** Registers one inspected upload; starts the run when every declared file has arrived. */
  function addUpload(runId, fieldKey, file) {
    const run = registry.get(runId);
    if (!run) throw new HttpError(404, 'not_found', 'The run does not exist.');
    if (run.status !== 'awaiting_upload') throw new HttpError(409, 'not_accepting_uploads', 'The run is not waiting for files.');
    const expected = run.meta.expectedFiles[fieldKey];
    if (!expected) throw new HttpError(400, 'unknown_field', 'This run does not expect a file for that input.');
    const received = run.meta.uploads[fieldKey];
    if (received.length >= expected) throw new HttpError(409, 'already_uploaded', 'All files for that input have been received.');

    // A file field with `textInto` is read as text and passed in that text input, so a runner receives the
    // same string whether the text was pasted or uploaded. The target's own length limit applies.
    const project = getProject(run.projectId);
    const field = project.inputs.find((input) => input.key === fieldKey);
    const target = field?.textInto ? project.inputs.find((input) => input.key === field.textInto) : null;
    if (target?.maxLength && file.content.trim().length > target.maxLength) {
      throw new HttpError(
        400,
        'text_too_long',
        `The text of the file exceeds the limit of ${target.maxLength} characters for the ${target.label.toLowerCase()}.`,
      );
    }

    if (target?.minLength && file.content.trim().length < target.minLength) {
      throw new HttpError(400, 'text_too_short', `The text of the file must contain at least ${target.minLength} characters.`);
    }

    received.push(file);
    const complete = Object.entries(run.meta.expectedFiles).every(([key, count]) => run.meta.uploads[key].length === count);
    if (!complete) return { started: false };

    const fromFiles = {};
    for (const [key, files] of Object.entries(run.meta.uploads)) {
      const input = project.inputs.find((candidate) => candidate.key === key);
      if (input.textInto) fromFiles[input.textInto] = files.map((item) => item.content.trim()).join('\n\n');
      else if (input.asText) fromFiles[key] = files.map((item) => ({ name: item.filename, text: item.text }));
      else fromFiles[key] = files;
    }
    registry.setInputs(runId, { ...run.inputs, ...fromFiles });
    run.meta.uploads = {};
    try {
      begin(runId);
    } catch (error) {
      registry.finish(runId, 'cancelled', error.message);
      throw error;
    }
    return { started: true };
  }

  /**
   * Applies a person's decision to a run that is waiting for one, and relays the rest of the run into the same run.
   * The caller has already validated the decision. Only one decision can be taken for a waiting run.
   */
  function decide(runId, { decision, feedback }) {
    const run = registry.get(runId);
    if (!run) throw new HttpError(404, 'not_found', 'The run does not exist.');
    if (run.status !== 'waiting') {
      throw new HttpError(409, 'not_waiting', 'The run is not waiting for a decision.');
    }
    // A waiting run does not count towards the limit, so resuming it must find room. If there is none, it keeps waiting.
    if (registry.countActive() >= config.maxConcurrentRuns) {
      throw new HttpError(503, 'at_capacity', 'The service is running its maximum number of runs. The report is still waiting; please try again shortly.');
    }
    if (!registry.claimWaiting(runId)) throw new HttpError(409, 'not_waiting', 'The run is not waiting for a decision.');

    const project = getProject(run.projectId);
    resumeRun({ project, runId, decision, feedback, registry, config, log }).catch((error) => {
      log.error(`Run ${runId}: ${error.message}`);
      registry.finish(runId, 'error', 'The run could not be completed.');
    });
    return { runId, status: run.status };
  }

  return { submit, addUpload, decide };
}
