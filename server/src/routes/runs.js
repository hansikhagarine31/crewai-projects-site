import { Router } from 'express';
import { zipSync } from 'fflate';
import { HttpError } from '../errors.js';
import { TERMINAL } from '../runs.js';
import { extractText } from '../extractText.js';
import { createUploadMiddleware, inspectUpload } from '../uploads.js';
import { validateDecision } from '../validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sse = (event, data, id) =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function parseLastEventId(value) {
  const id = Number.parseInt(value ?? '', 10);
  return Number.isInteger(id) && id >= 0 ? id : 0;
}

export function runRoutes({ config, registry, projects, service }) {
  const router = Router();
  const upload = createUploadMiddleware({ maxBytes: config.uploadMaxBytes });

  const findRun = (req, _res, next) => {
    const run = UUID.test(req.params.runId) ? registry.get(req.params.runId) : undefined;
    if (!run) return next(new HttpError(404, 'not_found', 'The run does not exist.'));
    req.run = run;
    return next();
  };

  router.post(
    '/runs/:runId/uploads',
    findRun,
    (req, _res, next) =>
      req.run.status === 'awaiting_upload'
        ? next()
        : next(new HttpError(409, 'not_accepting_uploads', 'The run is not waiting for files.')),
    upload,
    async (req, res) => {
      const fieldKey = req.body?.field;
      const project = projects.get(req.run.projectId);
      const field = project.inputs.find((input) => input.type === 'file' && input.key === fieldKey);
      if (!field) throw new HttpError(400, 'unknown_field', 'The "field" value does not name a file input of this project.');
      if (!req.file) throw new HttpError(400, 'no_file', 'No file was supplied in the "file" part.');

      const inspected = inspectUpload(req.file, field);
      // A field with `asText` is read as text here, so that the agents service never receives a raw file.
      const file = field.asText ? await extractText(inspected) : inspected;
      const { started } = service.addUpload(req.run.runId, fieldKey, file);
      res.status(201).json({ field: fieldKey, filename: file.filename, started });
    },
  );

  router.get('/runs/:runId/events', findRun, (req, res) => {
    const { run } = req;
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    // Announces the heartbeat interval at once, so the browser can detect a silent connection from the start.
    res.write(sse('heartbeat', { intervalMs: config.sseHeartbeatMs }));

    const lastId = parseLastEventId(req.get('last-event-id') ?? req.query.lastEventId);
    for (const entry of run.events) {
      if (entry.seq > lastId) res.write(sse('node', entry.event, entry.seq));
    }

    const close = () => {
      res.write(sse('end', { status: run.status, error: run.error }));
      res.end();
    };
    if (TERMINAL.has(run.status)) return close();

    let unsubscribe = () => {};
    // A comment keeps proxies from closing an idle connection; the named event lets the browser
    // notice that the connection has silently died, which comments do not allow.
    const beat = `: heartbeat\n\n${sse('heartbeat', { intervalMs: config.sseHeartbeatMs })}`;
    const heartbeat = setInterval(() => res.write(beat), config.sseHeartbeatMs);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    unsubscribe = registry.subscribe(run.runId, (message) => {
      if (message.type === 'event') {
        res.write(sse('node', message.entry.event, message.entry.seq));
      } else if (message.type === 'waiting') {
        // The connection stays open: the run continues in this same stream after the decision.
      } else {
        cleanup();
        close();
      }
    });
    req.on('close', cleanup);
  });

  router.get('/runs/:runId/result', findRun, (req, res) => {
    const { run } = req;
    if (!TERMINAL.has(run.status)) {
      return res.status(202).json({ runId: run.runId, status: run.status, ...(run.status === 'waiting' ? { review: run.review } : {}) });
    }
    return res.json({
      runId: run.runId,
      projectId: run.projectId,
      status: run.status,
      cached: run.cached,
      error: run.error,
      result: run.result,
      files: Object.values(run.files).map(({ name, size, contentType }) => ({
        name,
        size,
        contentType,
        url: `/api/runs/${run.runId}/files/${encodeURIComponent(name)}`,
      })),
      // All files in one archive, offered when there is more than one.
      zipUrl: Object.keys(run.files).length > 1 ? `/api/runs/${run.runId}/files.zip` : null,
    });
  });

  router.get('/runs/:runId/files/:name', findRun, (req, res) => {
    // Only names registered for this run are served; anything else, including path segments, is a 404.
    const file = Object.hasOwn(req.run.files, req.params.name) ? req.run.files[req.params.name] : undefined;
    if (!file) throw new HttpError(404, 'not_found', 'The file does not exist.');
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Content-Length': String(file.size),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    res.send(file.content);
  });

  router.get('/runs/:runId/files.zip', findRun, (req, res) => {
    const { run } = req;
    if (!TERMINAL.has(run.status)) throw new HttpError(409, 'not_finished', 'The run has not finished.');
    const files = Object.values(run.files);
    if (files.length === 0) throw new HttpError(404, 'not_found', 'The run produced no files.');
    // Names were reduced to a safe single path segment when the files were registered.
    const archive = zipSync(Object.fromEntries(files.map((file) => [file.name, new Uint8Array(file.content)])), { level: 6 });
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${run.projectId}-files.zip"`,
      'Content-Length': String(archive.length),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    res.send(Buffer.from(archive));
  });

  router.get('/runs/:runId/review', findRun, (req, res) => {
    const { run } = req;
    if (run.status !== 'waiting') throw new HttpError(409, 'not_waiting', 'The run is not waiting for a decision.');
    res.set('Cache-Control', 'private, no-store');
    res.json({ runId: run.runId, status: run.status, review: run.review });
  });

  router.post('/runs/:runId/decision', findRun, (req, res) => {
    const decision = validateDecision(req.body);
    const { status } = service.decide(req.run.runId, decision);
    res.status(202).json({ runId: req.run.runId, status });
  });

  router.post('/runs/:runId/cancel', findRun, (req, res) => {
    const { run } = req;
    if (!TERMINAL.has(run.status)) {
      run.abort.abort();
      registry.finish(run.runId, 'cancelled');
    }
    res.json({ runId: run.runId, status: run.status });
  });

  return router;
}
