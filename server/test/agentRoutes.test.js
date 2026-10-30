import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { config as baseConfig } from '../src/config.js';
import { getProject, listProjects } from '../src/projects.js';

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

describe('Assignment Agent Routes (/agent1 .. /agent10)', () => {
  let server;
  let port;
  let baseUrl;

  before(async () => {
    const config = {
      ...baseConfig,
      corsOrigin: 'http://localhost:5173',
      rateLimitRuns: 1000,
      maxConcurrentRuns: 50,
    };
    const { app } = createApp({
      config,
      log: quiet,
      projects: { get: getProject, list: listProjects },
      // mock startRun that completes immediately with result
      startRun: async ({ project, runId, registry }) => {
        registry.setResult(runId, { markdown: `CrewAI Output for ${project.title}` });
        registry.finish(runId, 'done');
      },
    });

    server = app.listen(0, '127.0.0.1');
    port = await listen(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.close();
  });

  describe('GET /agent1 .. /agent10 redirects', () => {
    it('redirects GET /agent1 to the blog-post-crew project page', async () => {
      const res = await fetch(`${baseUrl}/agent1`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'http://localhost:5173/projects/blog-post-crew');
    });

    it('redirects GET /agent10 to the approval-report-flow project page', async () => {
      const res = await fetch(`${baseUrl}/agent10`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'http://localhost:5173/projects/approval-report-flow');
    });

    it('returns JSON with project details when requested with Accept: application/json', async () => {
      const res = await fetch(`${baseUrl}/agent1`, {
        headers: { Accept: 'application/json' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.agent, 1);
      assert.equal(data.projectId, 'blog-post-crew');
      assert.ok(data.redirectUrl.includes('/projects/blog-post-crew'));
    });

    it('returns 404 for an invalid agent number', async () => {
      const res = await fetch(`${baseUrl}/agent99`, { redirect: 'manual' });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /agent1 .. /agent10 submission interface', () => {
    it('executes POST /agent1 and returns {"output": "..."}', async () => {
      const res = await fetch(`${baseUrl}/agent1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Artificial intelligence in healthcare' }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(typeof data.output === 'string');
      assert.ok(data.output.length > 0);
      assert.match(data.output, /Blog Post Crew/i);
    });

    it('returns 400 when "input" field is missing in POST /agent1', async () => {
      const res = await fetch(`${baseUrl}/agent1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error);
    });

    it('executes all routes /agent1 through /agent10 with valid input', async () => {
      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${baseUrl}/agent${i}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: `Test input for agent ${i}` }),
        });
        assert.equal(res.status, 200, `Agent ${i} should return 200 OK`);
        const data = await res.json();
        assert.ok(data.output, `Agent ${i} response should include output string`);
      }
    });

    it('also responds at /api/agent1 with {"output": "..."}', async () => {
      const res = await fetch(`${baseUrl}/api/agent1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Postman test query' }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.output);
    });
  });
});
