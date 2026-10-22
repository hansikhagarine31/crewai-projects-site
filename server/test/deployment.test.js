import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { configProblems, loadConfig, parseOrigins } from '../src/config.js';
import { createFakeAgent } from './fakeAgent.js';

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

describe('loadConfig', () => {
  it('reads the documented names', () => {
    const config = loadConfig({
      AGENT_BASE_URL: 'https://agents.example.org/',
      ALLOWED_ORIGIN: 'https://site.example.org',
      RATE_LIMIT: '7',
      AGENT_SHARED_SECRET: 'abc',
    });
    assert.equal(config.agentsUrl, 'https://agents.example.org');
    assert.equal(config.corsOrigin, 'https://site.example.org');
    assert.equal(config.rateLimitRuns, 7);
    assert.equal(config.agentSecret, 'abc');
  });

  it('still reads the earlier names, and prefers the documented ones', () => {
    assert.equal(loadConfig({ AGENTS_URL: 'http://agents:8001', CORS_ORIGIN: 'http://a', RATE_LIMIT_RUNS: '9' }).agentsUrl, 'http://agents:8001');
    assert.equal(loadConfig({ AGENTS_URL: 'http://old', AGENT_BASE_URL: 'http://new' }).agentsUrl, 'http://new');
    assert.equal(loadConfig({ CORS_ORIGIN: 'http://old', ALLOWED_ORIGIN: 'http://new' }).corsOrigin, 'http://new');
    assert.equal(loadConfig({ RATE_LIMIT_RUNS: '9' }).rateLimitRuns, 9);
  });

  it('uses safe defaults when nothing is set, and ignores empty or non-numeric values', () => {
    const config = loadConfig({ RATE_LIMIT: '', ALLOWED_ORIGIN: '', AGENT_BASE_URL: '' });
    assert.equal(config.rateLimitRuns, 5);
    assert.equal(config.corsOrigin, 'http://localhost:5173');
    assert.equal(config.agentsUrl, 'http://127.0.0.1:8001');
    assert.equal(loadConfig({ RATE_LIMIT: 'many' }).rateLimitRuns, 5);
  });
});

describe('parseOrigins', () => {
  it('removes trailing slashes, which a browser never sends in the Origin header', () => {
    assert.equal(parseOrigins('https://site.example.org/'), 'https://site.example.org');
  });

  it('accepts a comma-separated list', () => {
    assert.deepEqual(parseOrigins('https://a.example.org, https://b.example.org/'), ['https://a.example.org', 'https://b.example.org']);
  });
});

describe('CORS, headers for the event stream and the health report', () => {
  async function start(overrides = {}) {
    const agent = createFakeAgent({ secret: 's', delayMs: 5 });
    const agentPort = await listen(agent.server);
    const config = loadConfig({ ALLOWED_ORIGIN: 'https://site.example.org', AGENT_SHARED_SECRET: 's', AGENT_BASE_URL: `http://127.0.0.1:${agentPort}` });
    const { app } = createApp({ config: { ...config, ...overrides }, log: quiet });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return {
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => {
        server.closeAllConnections();
        agent.server.closeAllConnections();
        server.close();
        agent.server.close();
      },
    };
  }

  it('allows the configured origin and no other', async () => {
    const s = await start();
    try {
      const allowed = await fetch(`${s.base}/api/projects`, { headers: { origin: 'https://site.example.org' } });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://site.example.org');
      const other = await fetch(`${s.base}/api/projects`, { headers: { origin: 'https://evil.example.net' } });
      // With one configured origin the header always names that origin; a browser on another origin refuses the response.
      assert.equal(other.headers.get('access-control-allow-origin'), 'https://site.example.org');
      assert.notEqual(other.headers.get('access-control-allow-origin'), 'https://evil.example.net');
    } finally {
      s.close();
    }
  });

  it('with several origins, answers only the listed ones', async () => {
    const s = await start({ corsOrigin: parseOrigins('https://a.example.org,https://b.example.org') });
    try {
      const call = (origin) => fetch(`${s.base}/api/projects`, { headers: { origin } });
      assert.equal((await call('https://b.example.org')).headers.get('access-control-allow-origin'), 'https://b.example.org');
      assert.equal((await call('https://evil.example.net')).headers.get('access-control-allow-origin'), null);
    } finally {
      s.close();
    }
  });

  it('answers a preflight request for the configured origin only', async () => {
    const s = await start();
    try {
      const preflight = (origin) =>
        fetch(`${s.base}/api/projects/demo/runs`, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
        });
      const ok = await preflight('https://site.example.org');
      assert.equal(ok.headers.get('access-control-allow-origin'), 'https://site.example.org');
      assert.match(ok.headers.get('access-control-allow-headers'), /content-type/i);
      assert.notEqual((await preflight('https://evil.example.net')).headers.get('access-control-allow-origin'), 'https://evil.example.net');
    } finally {
      s.close();
    }
  });

  it('never answers with a wildcard origin', async () => {
    const s = await start();
    try {
      const response = await fetch(`${s.base}/api/projects`, { headers: { origin: 'https://site.example.org' } });
      assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    } finally {
      s.close();
    }
  });

  it('sends the headers that keep a proxy from buffering the event stream, with the CORS header', async () => {
    const s = await start();
    try {
      const start = await fetch(`${s.base}/api/projects/demo/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://site.example.org' },
        body: JSON.stringify({ inputs: { topic: 'x' } }),
      });
      const { runId } = await start.json();
      const stream = await fetch(`${s.base}/api/runs/${runId}/events`, { headers: { origin: 'https://site.example.org' } });
      assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
      assert.equal(stream.headers.get('x-accel-buffering'), 'no');
      assert.match(stream.headers.get('cache-control'), /no-cache/);
      assert.match(stream.headers.get('cache-control'), /no-transform/);
      assert.equal(stream.headers.get('content-encoding'), null);
      assert.equal(stream.headers.get('access-control-allow-origin'), 'https://site.example.org');
      await stream.text();
    } finally {
      s.close();
    }
  });

  it('answers the liveness check without calling the agents service', async () => {
    const s = await start({ agentsUrl: 'http://127.0.0.1:9' });
    try {
      const response = await fetch(`${s.base}/api/live`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { server: 'ok' });
    } finally {
      s.close();
    }
  });

  it('does not reveal the address of the agents service when it cannot be reached', async () => {
    const s = await start({ agentsUrl: 'http://agents.internal.example:9' });
    try {
      const response = await fetch(`${s.base}/api/health`);
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.doesNotMatch(text, /agents\.internal|:9/);
      assert.match(text, /could not be reached/);
    } finally {
      s.close();
    }
  });
});

describe('configProblems', () => {
  const sound = { agentSecret: 's', corsOrigin: 'https://site.example.org', agentsUrl: 'https://agents.example.org' };

  it('reports nothing for a sound configuration', () => {
    assert.deepEqual(configProblems(sound), []);
  });

  it('reports a missing secret, a wildcard origin and an address without a scheme', () => {
    assert.equal(configProblems({ ...sound, agentSecret: '' }).length, 1);
    assert.equal(configProblems({ ...sound, corsOrigin: '*' }).length, 1);
    assert.equal(configProblems({ ...sound, corsOrigin: ['https://a.example.org', '*'] }).length, 1);
    assert.equal(configProblems({ ...sound, agentsUrl: 'agents.example.org' }).length, 1);
  });
});
