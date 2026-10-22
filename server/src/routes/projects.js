import { Router } from 'express';
import { HttpError } from '../errors.js';
import { runLimiter } from '../middleware/rateLimit.js';
import { validateRunRequest } from '../validation.js';

const publicView = ({ id, number, title, type, pattern, inputs, nodes, requireAnyOf }) => ({
  id,
  number,
  title,
  type,
  pattern,
  inputs,
  nodes,
  requireAnyOf,
});

export function projectRoutes({ config, projects, service, validateUrl }) {
  const router = Router();

  router.get('/projects', (_req, res) => {
    res.json({ projects: projects.list().map(publicView) });
  });

  router.get('/projects/:id', (req, res) => {
    const project = projects.get(req.params.id);
    if (!project) throw new HttpError(404, 'not_found', 'The project does not exist.');
    res.json(publicView(project));
  });

  router.post('/projects/:id/runs', runLimiter(config), async (req, res) => {
    const project = projects.get(req.params.id);
    if (!project) throw new HttpError(404, 'not_found', 'The project does not exist.');

    const validated = await validateRunRequest(project, req.body, { validateUrl });
    const { runId, awaiting } = service.submit(project, validated);
    res.status(202).json({ runId, awaitingFiles: awaiting });
  });

  return router;
}
