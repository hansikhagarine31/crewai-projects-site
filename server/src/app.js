import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { discardState as defaultDiscardState } from './agentClient.js';
import { createCache } from './cache.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { getProject, listProjects } from './projects.js';
import { createRunRegistry } from './runs.js';
import { createRunService } from './runService.js';
import { projectRoutes } from './routes/projects.js';
import { runRoutes } from './routes/runs.js';

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === false || value === 'false') return false;
  return /^\d+$/.test(String(value)) ? Number(value) : value;
}

/** Builds the Express app. Dependencies are injectable so tests can substitute them. */
export function createApp({
  config,
  discardState = defaultDiscardState,
  registry = createRunRegistry({
    ...config,
    // A run that ends without a result (cancelled, timed out, expired) may have a draft stored on the agents service.
    onFinish: (run) => {
      if (run.hasState && run.status !== 'done') discardState({ runId: run.runId, config, log });
    },
  }),
  cache = createCache({ ttlMs: config.cacheTtlMs, maxEntries: config.cacheMaxEntries }),
  projects = { get: getProject, list: listProjects },
  startRun,
  resumeRun,
  validateUrl,
  log = console,
}) {
  const app = express();
  app.set('trust proxy', parseTrustProxy(config.trustProxy));
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, allowedHeaders: ['content-type', 'last-event-id'], exposedHeaders: ['Retry-After'] }));

  app.get('/api/health', async (_req, res) => {
    try {
      const response = await fetch(`${config.agentsUrl}/health`, {
        headers: { 'x-agent-secret': config.agentSecret },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return res.status(502).json({
          server: 'ok',
          agents: 'error',
          error: `Agents service responded with status ${response.status}.`,
        });
      }
      return res.json({ server: 'ok', agents: 'ok' });
    } catch (err) {
      return res.status(503).json({
        server: 'ok',
        agents: 'unreachable',
        error: `Agents service at ${config.agentsUrl} could not be reached (${err.cause?.code ?? err.name}).`,
      });
    }
  });

  const service = createRunService({ registry, cache, config, getProject: projects.get, startRun, resumeRun, log });

  app.use('/api', apiLimiter(), express.json({ limit: config.jsonLimit }));
  app.use('/api', projectRoutes({ config, projects, service, validateUrl }));
  app.use('/api', runRoutes({ config, registry, projects, service }));

  app.use(notFound);
  app.use(errorHandler(log));

  return { app, registry, cache, service };
}
