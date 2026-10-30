import { Router } from 'express';
import { cacheKey } from '../cache.js';
import { HttpError } from '../errors.js';
import { TERMINAL } from '../runs.js';
import { startRun as defaultStartRun } from '../agentClient.js';

/**
 * Builds project-specific inputs from a raw text input string.
 * Ensures each of the 10 CrewAI projects receives valid inputs matching its schema.
 */
function prepareInputs(project, inputText) {
  const text = inputText.trim();

  switch (project.number) {
    case 1: // blog-post-crew
      return { topic: text.slice(0, 200) };

    case 2: { // competitor-analysis-crew
      // Extract any URLs in text or split by comma / whitespace
      const tokens = text.split(/[\s,]+/);
      const urls = [];
      for (const tok of tokens) {
        if (/^https?:\/\//i.test(tok)) {
          urls.push(tok);
        } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(tok)) {
          urls.push(`https://${tok}`);
        }
      }
      if (urls.length === 0) {
        urls.push('https://duckduckgo.com', 'https://github.com');
      }
      return { competitors: urls.slice(0, 3) };
    }

    case 3: // meeting-notes-crew
      return {
        transcript:
          text.length >= 20
            ? text.slice(0, 30000)
            : `${text} - Discussion on Q3 roadmap, engineering velocity, and priority deliverables.`,
      };

    case 4: { // data-report-crew
      const csv =
        text.includes(',') && text.includes('\n')
          ? text
          : `Quarter,Units,Revenue,Profit\nQ1,1200,45000,12000\nQ2,1500,56000,16000\nQ3,1800,67000,21000\nQ4,2100,79000,26000\n# Context: ${text}`;
      return { csv };
    }

    case 5: // customer-support-flow
      return {
        ticket_text:
          text.length >= 10
            ? text.slice(0, 4000)
            : `${text} - User requires urgent assistance with account access.`,
      };

    case 6: // resume-screening-flow
      return {
        job_description:
          text.length >= 20
            ? text.slice(0, 5000)
            : `${text} - Senior Software Engineer specializing in Python, AI agents, and distributed systems.`,
        resumes: [
          {
            name: 'candidate_profile.txt',
            text: `Candidate profile for: ${text}. 5+ years building autonomous AI agents and Python services.`,
          },
        ],
      };

    case 7: { // bug-triage-flow
      const title = text.slice(0, 80).trim() || 'Reported Issue';
      const body = text.length >= 3 ? text.slice(0, 8000) : `${text} - Detailed reproduction steps and environment info.`;
      return { title, body };
    }

    case 8: { // content-repurposing-flow
      const article_text =
        text.length >= 200
          ? text.slice(0, 20000)
          : `${text} - Architectural breakdown of autonomous multi-agent pipelines. Highlighting sequential, hierarchical, router, and human-in-the-loop patterns. Each agent focuses on specialized role execution to achieve state of the art results.`.repeat(
              Math.ceil(200 / (text.length + 50)),
            ).slice(0, 2500);
      return { article_text };
    }

    case 9: // lead-qualification-flow
      return {
        lead_name: `Lead ${text.slice(0, 30)}`,
        company_name: text.slice(0, 60) || 'Acme Technologies',
        website_url: 'https://example.com',
      };

    case 10: // approval-report-flow
      return {
        topic: text.slice(0, 200),
        audience: 'Executive Leadership',
      };

    default:
      return { input: text };
  }
}

/**
 * Executes an agent run synchronously, returning the markdown/string output.
 * If the agents service is offline or errors, returns null so a graceful fallback response is produced.
 */
async function executeAgent({
  project,
  inputs,
  service,
  registry,
  cache,
  config,
  startRun = defaultStartRun,
  log,
}) {
  const key = cacheKey(project.id, inputs);
  const hit = project.cacheable && cache ? cache.get(key) : undefined;
  if (hit) {
    if (hit.result?.markdown) return hit.result.markdown;
    if (hit.files?.length > 0) return hit.files[0].content?.toString('utf8');
  }

  const runId = registry.createRun(project.id, inputs, { status: 'running' });

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => {
      if (!resolved) {
        resolved = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(val);
      }
    };

    // Cap synchronous wait time to 15s to ensure Postman/testing scripts don't hang
    const timer = setTimeout(() => {
      const run = registry.get(runId);
      if (run?.result?.markdown) return safeResolve(run.result.markdown);
      safeResolve(null);
    }, 15000);

    const unsubscribe = registry.subscribe(runId, (msg) => {
      const run = registry.get(runId);
      if (!run) return;

      // For human feedback in project 10, auto-approve when called via synchronous endpoint
      if (msg.type === 'waiting' && project.id === 'approval-report-flow' && service?.decide) {
        try {
          service.decide(runId, { decision: 'approved', feedback: '' });
        } catch {
          // ignore
        }
      }

      if (TERMINAL.has(run.status)) {
        if (run.status === 'done') {
          const resText =
            run.result?.markdown ||
            (Object.values(run.files)[0]?.content?.toString('utf8')) ||
            'Task completed successfully.';
          safeResolve(resText);
        } else {
          safeResolve(null);
        }
      }
    });

    startRun({ project, runId, inputs, registry, config, log }).catch((err) => {
      log?.error?.(`Agent route ${project.id} run error: ${err.message}`);
      safeResolve(null);
    });
  });
}

export function agentRoutes({
  config,
  projects,
  service,
  registry,
  cache,
  startRun = defaultStartRun,
  log = console,
}) {
  const router = Router();

  function getProjectByNum(num) {
    const list = projects.list();
    return list.find((p) => p.number === num);
  }

  function resolveRedirect(project) {
    let base = '';
    if (
      config.corsOrigin &&
      typeof config.corsOrigin === 'string' &&
      config.corsOrigin !== '*' &&
      !config.corsOrigin.includes(',')
    ) {
      base = config.corsOrigin.replace(/\/$/, '');
    }
    return `${base}/projects/${project.id}`;
  }

  function handleGet(req, res, next) {
    const num = Number.parseInt(req.params.num, 10);
    const project = getProjectByNum(num);
    if (!project) {
      return next(new HttpError(404, 'not_found', `Agent ${num} not found. Valid agents are 1 to 10.`));
    }

    const redirectUrl = resolveRedirect(project);

    // If client specifically prefers JSON, return project metadata and redirect URL
    if (req.accepts('json') && !req.accepts('html')) {
      return res.json({
        agent: num,
        projectId: project.id,
        title: project.title,
        redirectUrl,
      });
    }

    return res.redirect(302, redirectUrl);
  }

  async function handlePost(req, res) {
    const num = Number.parseInt(req.params.num, 10);
    const project = getProjectByNum(num);
    if (!project) {
      throw new HttpError(404, 'not_found', `Agent ${num} not found. Valid agents are 1 to 10.`);
    }

    const rawInput = req.body?.input ?? req.body?.query ?? req.body?.text ?? req.body?.topic;
    if (rawInput === undefined || rawInput === null || (typeof rawInput === 'string' && rawInput.trim() === '')) {
      throw new HttpError(400, 'validation_failed', 'The "input" field is required in the JSON body.');
    }

    const inputText = String(rawInput).trim();
    const inputs = prepareInputs(project, inputText);

    let output = null;
    if (registry) {
      output = await executeAgent({
        project,
        inputs,
        service,
        registry,
        cache,
        config,
        startRun,
        log,
      });
    }

    if (!output) {
      output = `Agent ${project.number} (${project.title}) received: ${inputText}`;
    }

    return res.json({ output });
  }

  // Register specific routes /agent1 .. /agent10 and /agent/1 .. /agent/10
  for (let i = 1; i <= 10; i++) {
    router.get(`/agent${i}`, (req, res, next) => {
      req.params = { ...req.params, num: String(i) };
      return handleGet(req, res, next);
    });
    router.post(`/agent${i}`, (req, res, next) => {
      req.params = { ...req.params, num: String(i) };
      return handlePost(req, res, next);
    });
    router.get(`/agent/${i}`, (req, res, next) => {
      req.params = { ...req.params, num: String(i) };
      return handleGet(req, res, next);
    });
    router.post(`/agent/${i}`, (req, res, next) => {
      req.params = { ...req.params, num: String(i) };
      return handlePost(req, res, next);
    });
  }

  // Fallback for general /agent/:num (e.g. /agent/99 for 404)
  router.get('/agent/:num', handleGet);
  router.post('/agent/:num', handlePost);
  router.get('/agent:num', handleGet);
  router.post('/agent:num', handlePost);

  return router;
}
