import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { config as baseConfig } from '../src/config.js';
import { validateDecision } from '../src/validation.js';
import { createFakeAgent } from './fakeAgent.js';

const SECRET = 'test-secret';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const INPUTS = { topic: 'Vertical farming', audience: 'City planners' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => {
      const message = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) message.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) message.event = line.slice(7);
        else if (line.startsWith('data: ')) message.data = JSON.parse(line.slice(6));
      }
      return message;
    })
    .filter((message) => message.event);
}

/** Starts the fake agent and the app; returns helpers bound to them. */
async function setup(overrides = {}) {
  const agent = createFakeAgent({ secret: SECRET, delayMs: 5 });
  const agentPort = await listen(agent.server);
  const config = {
    ...baseConfig,
    agentsUrl: `http://127.0.0.1:${agentPort}`,
    agentSecret: SECRET,
    cacheReplayDelayMs: 1,
    rateLimitRuns: 1000,
    maxConcurrentRuns: 50,
    ...overrides,
  };
  const { app, registry } = createApp({ config, log: quiet });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = {
    base,
    registry,
    agent,
    post: (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    get: (path) => fetch(base + path),
    async start(inputs = INPUTS, project = 'approval-report-flow') {
      const response = await api.post(`/api/projects/${project}/runs`, { inputs });
      assert.equal(response.status, 202);
      return (await response.json()).runId;
    },
    async status(runId) {
      const response = await api.get(`/api/runs/${runId}/result`);
      return { code: response.status, body: await response.json() };
    },
    async until(runId, wanted, rounds = 300) {
      for (let i = 0; i < rounds; i++) {
        const { body } = await api.status(runId);
        if (body.status === wanted) return body;
        await sleep(10);
      }
      throw new Error(`The run never reached ${wanted}.`);
    },
    decide: (runId, body) => api.post(`/api/runs/${runId}/decision`, body),
    async waitingRun(inputs) {
      const runId = await api.start(inputs);
      await api.until(runId, 'waiting');
      return runId;
    },
    async events(runId) {
      return parseSse(await (await api.get(`/api/runs/${runId}/events`)).text());
    },
    close: async () => {
      server.closeAllConnections();
      agent.server.closeAllConnections();
      server.close();
      agent.server.close();
    },
  };
  return api;
}

describe('decision validation', () => {
  it('accepts approval without feedback and drops any that is sent', () => {
    assert.deepEqual(validateDecision({ decision: 'approved', feedback: 'thanks' }), { decision: 'approved', feedback: '' });
  });

  it('requires trimmed, plain feedback of at most 2000 characters to revise', () => {
    assert.deepEqual(validateDecision({ decision: 'revise', feedback: '  Shorten it.  ' }), { decision: 'revise', feedback: 'Shorten it.' });
    for (const feedback of [undefined, '', '   ', 5, 'x'.repeat(2001), 'a\u0000b']) {
      assert.throws(() => validateDecision({ decision: 'revise', feedback }), (error) => error.status === 400);
    }
  });

  it('refuses any other decision', () => {
    for (const body of [undefined, {}, { decision: 'maybe' }, { decision: 'Approved' }, { decision: ['approved'] }]) {
      assert.throws(() => validateDecision(body), (error) => error.status === 400);
    }
  });
});

describe('API: a run that waits for a decision', () => {
  let api;
  const apis = [];
  const open = async (overrides) => {
    api = await setup(overrides);
    apis.push(api);
  };
  after(async () => {
    for (const created of apis) await created.close();
  });

  describe('the first part', () => {
    before(() => open());

    it('ends in the waiting state with the draft, and the stream stays open', async () => {
      const runId = await api.start();
      const body = await api.until(runId, 'waiting');
      assert.equal(body.review.round, 1);
      assert.match(body.review.draft, /^# Draft 1/);
      assert.equal(body.review.revisionsLeft, 3);
      assert.ok(body.review.expiresAt > Date.now() + 29 * 60 * 1000);

      const response = await api.get(`/api/runs/${runId}/events`);
      const reader = response.body.getReader();
      let text = '';
      const deadline = Date.now() + 400;
      while (Date.now() < deadline && !text.includes('event: end')) {
        const read = await Promise.race([reader.read(), sleep(100).then(() => null)]);
        if (read?.value) text += Buffer.from(read.value).toString();
        if (read?.done) break;
      }
      assert.match(text, /"nodeId":"review_draft","status":"waiting"/);
      assert.doesNotMatch(text, /event: end/);
      await reader.cancel();
    });

    it('serves the review to a page that was reloaded', async () => {
      const runId = await api.waitingRun();
      const response = await api.get(`/api/runs/${runId}/review`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).review.round, 1);
    });

    it('refuses the review of a run that is not waiting', async () => {
      const runId = await api.start({ topic: 'hello' }, 'demo');
      await api.until(runId, 'done');
      assert.equal((await api.get(`/api/runs/${runId}/review`)).status, 409);
    });
  });

  describe('the decision', () => {
    before(() => open());

    it('rejects a decision that is neither approved nor revise', async () => {
      const runId = await api.waitingRun();
      for (const body of [{}, { decision: 'maybe' }, { decision: 5 }, { decision: 'revise ' }]) {
        const response = await api.decide(runId, body);
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      assert.equal((await api.status(runId)).body.status, 'waiting');
    });

    it('requires feedback to revise, and limits its length', async () => {
      const runId = await api.waitingRun();
      const bad = [{}, { feedback: '' }, { feedback: '   ' }, { feedback: 7 }, { feedback: 'x'.repeat(2001) }, { feedback: 'bad\u0000text' }];
      for (const extra of bad) {
        const response = await api.decide(runId, { decision: 'revise', ...extra });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.details[0].field, 'feedback');
      }
      assert.equal((await api.status(runId)).body.status, 'waiting');
      assert.equal(api.agent.resumes.filter((item) => item.runId === runId).length, 0);
    });

    it('accepts feedback of exactly 2000 characters and trims it', async () => {
      const runId = await api.waitingRun();
      assert.equal((await api.decide(runId, { decision: 'revise', feedback: `  ${'x'.repeat(2000)}  ` })).status, 202);
      await api.until(runId, 'waiting');
      assert.equal(api.agent.resumes.at(-1).feedback.length, 2000);
    });

    it('does not pass on any feedback sent with an approval', async () => {
      const runId = await api.waitingRun();
      assert.equal((await api.decide(runId, { decision: 'approved', feedback: 'thank you' })).status, 202);
      await api.until(runId, 'done');
      assert.deepEqual(api.agent.resumes.at(-1), { runId, decision: 'approved', feedback: '' });
    });

    it('answers 404 for an unknown run and 409 for a run that is not waiting', async () => {
      assert.equal((await api.decide('11111111-2222-4333-8444-555555555555', { decision: 'approved' })).status, 404);
      assert.equal((await api.decide('not-a-run', { decision: 'approved' })).status, 404);
      const runId = await api.start({ topic: 'hello' }, 'demo');
      await api.until(runId, 'done');
      const response = await api.decide(runId, { decision: 'approved' });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'not_waiting');
    });

    it('lets only one of two simultaneous decisions through', async () => {
      const runId = await api.waitingRun();
      const responses = await Promise.all([
        api.decide(runId, { decision: 'approved' }),
        api.decide(runId, { decision: 'revise', feedback: 'Change it.' }),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
      await sleep(100);
      assert.equal(api.agent.resumes.filter((item) => item.runId === runId).length, 1);
    });
  });

  describe('the whole cycle', () => {
    before(() => open());

    it('runs, is revised once and is approved, all in one run and one event stream', async () => {
      const runId = await api.start();
      await api.until(runId, 'waiting');
      const stream = api.events(runId); // one connection from the first part to the end

      assert.equal((await api.decide(runId, { decision: 'revise', feedback: 'Please shorten the introduction.' })).status, 202);
      const second = await api.until(runId, 'waiting');
      assert.equal(second.review.round, 2);
      assert.equal(second.review.revisionsUsed, 1);
      assert.match(second.review.draft, /^# Draft 2/);

      assert.equal((await api.decide(runId, { decision: 'approved' })).status, 202);
      const messages = await stream;

      const nodes = messages.filter((message) => message.event === 'node');
      const labels = nodes.map((message) => `${message.data.nodeId}:${message.data.status}`);
      assert.deepEqual(
        labels.filter((item) => item.startsWith('review_draft')),
        ['review_draft:waiting', 'review_draft:done', 'review_draft:waiting', 'review_draft:done'],
      );
      assert.ok(labels.includes('revision_crew:done') && labels.includes('publish_report:done'));
      const ids = nodes.map((message) => message.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
      assert.equal(new Set(ids).size, ids.length); // one numbered sequence
      assert.equal(messages.at(-1).event, 'end');
      assert.equal(messages.at(-1).data.status, 'done');

      const { code, body } = await api.status(runId);
      assert.equal(code, 200);
      assert.match(body.result.markdown, /Revisions: 1/);
      assert.deepEqual(body.files.map((file) => file.name), ['final.md']);
      assert.deepEqual(api.agent.resumes.filter((item) => item.runId === runId).map((item) => item.decision), ['revise', 'approved']);
    });

    it('ends with a message after three revisions and a fourth request', async () => {
      const runId = await api.waitingRun();
      for (let round = 1; round <= 3; round++) {
        assert.equal((await api.decide(runId, { decision: 'revise', feedback: `Change ${round}.` })).status, 202);
        const body = await api.until(runId, 'waiting');
        assert.equal(body.review.revisionsUsed, round);
      }
      assert.equal((await api.status(runId)).body.review.revisionsLeft, 0);
      assert.equal((await api.decide(runId, { decision: 'revise', feedback: 'Once more.' })).status, 202);
      const body = await api.until(runId, 'done');
      assert.match(body.result.markdown, /^# Draft not approved/);
    });

    it('a second run with the same inputs waits again and is not replayed from the cache', async () => {
      const first = await api.waitingRun();
      await api.decide(first, { decision: 'approved' });
      await api.until(first, 'done');
      const second = await api.start();
      const body = await api.until(second, 'waiting');
      assert.equal(body.review.round, 1);
    });
  });

  describe('the time limit and the cap on runs', () => {
    it('ends a run that waited too long, tells the person and deletes the stored draft', async () => {
      await open({ waitingTtlMs: 60 });
      const runId = await api.waitingRun();
      await sleep(80);
      api.registry.sweep();
      const { code, body } = await api.status(runId);
      assert.equal(code, 200);
      assert.equal(body.status, 'expired');
      assert.match(body.error, /not reviewed within 30 minutes/);
      await sleep(50);
      assert.ok(api.agent.deleted.includes(runId));
      assert.equal(api.agent.stored.has(runId), false);
      assert.equal((await api.decide(runId, { decision: 'approved' })).status, 409);
    });

    it('marks the waiting node as skipped when the run expires', async () => {
      await open({ waitingTtlMs: 60 });
      const runId = await api.waitingRun();
      await sleep(80);
      api.registry.sweep();
      const events = api.registry.get(runId).events.map(({ event }) => event).filter((event) => event.nodeId === 'review_draft');
      assert.deepEqual(events.map((event) => event.status), ['waiting', 'skipped']);
    });

    it('closes the stream of an expired run with the status "expired"', async () => {
      await open({ waitingTtlMs: 60 });
      const runId = await api.waitingRun();
      const stream = api.events(runId);
      await sleep(80);
      api.registry.sweep();
      const messages = await stream;
      assert.deepEqual([messages.at(-1).event, messages.at(-1).data.status], ['end', 'expired']);
    });

    it('does not expire a run that has not waited long enough', async () => {
      await open({ waitingTtlMs: 60_000 });
      const runId = await api.waitingRun();
      api.registry.sweep();
      assert.equal((await api.status(runId)).body.status, 'waiting');
    });

    it('does not count a waiting run towards the cap on concurrent runs', async () => {
      await open({ maxConcurrentRuns: 1 });
      const first = await api.waitingRun();
      assert.equal(api.registry.countActive(), 0);
      const second = await api.waitingRun(); // would be refused with 503 if the first still counted
      assert.notEqual(first, second);
    });

    it('keeps the run waiting when there is no room to resume it', async () => {
      await open({ maxConcurrentRuns: 1 });
      const runId = await api.waitingRun();
      const busy = await api.start({ topic: 'slow' }, 'demo');
      const response = await api.decide(runId, { decision: 'approved' });
      assert.equal(response.status, 503);
      assert.equal((await api.status(runId)).body.status, 'waiting');
      assert.equal(api.agent.resumes.length, 0);
      await api.post(`/api/runs/${busy}/cancel`, {});
      await api.until(busy, 'cancelled');
      assert.equal((await api.decide(runId, { decision: 'approved' })).status, 202); // now there is room
      await api.until(runId, 'done');
    });

    it('counts a resumed run again while it works', async () => {
      await open({ maxConcurrentRuns: 1 });
      const runId = await api.waitingRun({ ...INPUTS, topic: 'slow' });
      await api.decide(runId, { decision: 'approved' });
      assert.equal(api.registry.countActive(), 1);
      await api.post(`/api/runs/${runId}/cancel`, {});
      await api.until(runId, 'cancelled');
    });
  });

  describe('cancelling and failing', () => {
    before(() => open());

    it('cancelling a waiting run ends it and deletes the stored draft', async () => {
      const runId = await api.waitingRun();
      const response = await api.post(`/api/runs/${runId}/cancel`, {});
      assert.equal((await response.json()).status, 'cancelled');
      await sleep(50);
      assert.ok(api.agent.deleted.includes(runId));
    });

    it('cancelling during a resumed part ends the run and deletes the stored draft', async () => {
      const runId = await api.waitingRun({ ...INPUTS, topic: 'slow' });
      await api.decide(runId, { decision: 'approved' });
      await sleep(50);
      await api.post(`/api/runs/${runId}/cancel`, {});
      await api.until(runId, 'cancelled');
      await sleep(50);
      assert.ok(api.agent.deleted.includes(runId));
    });

    it('reports an expired draft when the agents service has already deleted it', async () => {
      const runId = await api.waitingRun();
      api.agent.expired.add(runId);
      await api.decide(runId, { decision: 'approved' });
      const body = await api.until(runId, 'expired');
      assert.match(body.error, /not reviewed within 30 minutes/);
    });

    it('reports a missing draft in plain words', async () => {
      const runId = await api.waitingRun();
      api.agent.stored.delete(runId);
      await api.decide(runId, { decision: 'approved' });
      const body = await api.until(runId, 'error');
      assert.equal(body.error, 'The stored draft is no longer available.');
    });
  });
});
