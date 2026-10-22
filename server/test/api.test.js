import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { config as baseConfig } from '../src/config.js';
import { getProject, listProjects } from '../src/projects.js';
import { validateInputUrl } from '../src/security/urlGuard.js';
import { unzipSync } from 'fflate';
import { createFakeAgent } from './fakeAgent.js';
import { makePdf } from './makePdf.js';

const SECRET = 'test-secret';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
// A synthetic project with a plain file input, so that the generic upload tests do not depend on a real project.
const FILES_TEST = {
  id: 'files-test',
  title: 'Upload test',
  cacheable: false,
  inputs: [{ key: 'article', label: 'Article', type: 'file', required: true, extensions: ['.txt'], maxFiles: 1 }],
  nodes: [{ nodeId: 'a', kind: 'input', name: 'a' }, { nodeId: 'b', kind: 'output', name: 'b' }],
};
const withFilesTest = () => ({ get: (id) => (id === FILES_TEST.id ? FILES_TEST : getProject(id)), list: listProjects });

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const validateUrl = (url) => validateInputUrl(url, { lookup: publicLookup });

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

/** Starts the fake agent and the app; returns helpers bound to them. */
async function setup(overrides = {}, projects) {
  const agent = createFakeAgent({ secret: SECRET, delayMs: 10, getProject: projects?.get });
  const agentPort = await listen(agent.server);
  const config = {
    ...baseConfig,
    agentsUrl: `http://127.0.0.1:${agentPort}`,
    agentSecret: SECRET,
    cacheReplayDelayMs: 1,
    rateLimitRuns: 1000,
    maxConcurrentRuns: 50,
    uploadMaxBytes: 2000,
    ...overrides,
  };
  const { app, registry } = createApp({ config, validateUrl, log: quiet, projects });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = {
    base,
    registry,
    agent,
    post: (path, body) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    get: (path, headers) => fetch(base + path, { headers }),
    async startDemo(topic) {
      const response = await api.post('/api/projects/demo/runs', { inputs: { topic } });
      assert.equal(response.status, 202);
      return (await response.json()).runId;
    },
    async upload(runId, field, name, content, type = 'text/plain') {
      const form = new FormData();
      form.append('field', field);
      form.append('file', new Blob([content], { type }), name);
      return fetch(`${base}/api/runs/${runId}/uploads`, { method: 'POST', body: form });
    },
    async waitForEnd(runId) {
      const response = await api.get(`/api/runs/${runId}/events`);
      return parseSse(await response.text());
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

/** Splits an SSE body into { id, event, data } messages, ignoring comments. */
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

describe('API: runs, events, results and files', () => {
  let api;
  before(async () => {
    api = await setup();
  });
  after(() => api.close());

  it('reports the health chain', async () => {
    const response = await api.get('/api/health');
    assert.deepEqual(await response.json(), { server: 'ok', agents: 'ok' });
  });

  it('sets security headers and does not reveal the framework', async () => {
    const response = await api.get('/api/health');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('streams contract events over SSE and closes when the run ends', async () => {
    const runId = await api.startDemo('streaming');
    const messages = await api.waitForEnd(runId);

    const nodes = messages.filter((message) => message.event === 'node');
    assert.equal(nodes.length, 10); // five nodes, running then done
    assert.deepEqual(nodes.map((message) => message.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const { data } of nodes) {
      assert.deepEqual(Object.keys(data).sort(), ['message', 'nodeId', 'runId', 'status', 'ts']);
      assert.equal(data.runId, runId);
    }
    assert.deepEqual(nodes.map((message) => message.data.nodeId).filter((id, i, all) => all.indexOf(id) === i), [
      'topic', 'plan', 'research', 'compose', 'demo_md',
    ]);
    assert.deepEqual(messages.at(-1), { event: 'end', data: { status: 'done', error: null } });
  });

  it('honours Last-Event-ID by replaying only later events', async () => {
    const runId = await api.startDemo('resume');
    await api.waitForEnd(runId);
    const response = await api.get(`/api/runs/${runId}/events`, { 'Last-Event-ID': '8' });
    const messages = parseSse(await response.text());
    assert.deepEqual(messages.filter((m) => m.event === 'node').map((m) => m.id), [9, 10]);
  });

  it('sends heartbeat comments while a run is in progress', async () => {
    const fast = await setup({ sseHeartbeatMs: 40 });
    try {
      const runId = await fast.startDemo('slow');
      const response = await fast.get(`/api/runs/${runId}/events`);
      const reader = response.body.getReader();
      let text = '';
      const deadline = Date.now() + 1000;
      while (!(text.includes(': heartbeat') && text.includes('intervalMs')) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      await reader.cancel();
      assert.match(text, /: heartbeat/);
      assert.match(text, /event: heartbeat\ndata: \{"intervalMs":40\}/);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
    } finally {
      await fast.close();
    }
  });

  it('returns the result and registered output files', async () => {
    const runId = await api.startDemo('result');
    await api.waitForEnd(runId);
    const body = await (await api.get(`/api/runs/${runId}/result`)).json();
    assert.equal(body.status, 'done');
    assert.equal(body.cached, false);
    assert.deepEqual(body.result, { markdown: '# Completed demo\n\nTopic: result\n' });
    assert.deepEqual(body.files.map((file) => file.name).sort(), ['data.bin', 'demo.md']);
  });

  it('answers 202 for the result of a run that has not finished', async () => {
    const runId = await api.startDemo('slow');
    const response = await api.get(`/api/runs/${runId}/result`);
    assert.equal(response.status, 202);
    await api.post(`/api/runs/${runId}/cancel`, {});
  });

  it('downloads a registered file with safe headers', async () => {
    const runId = await api.startDemo('download');
    await api.waitForEnd(runId);
    const response = await api.get(`/api/runs/${runId}/files/demo.md`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="demo.md"');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), '# Result\n\nTopic: download\n');

    const binary = await api.get(`/api/runs/${runId}/files/data.bin`);
    assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [1, 2, 3, 4]);
  });

  it('refuses unregistered names and path traversal', async () => {
    const runId = await api.startDemo('traversal');
    await api.waitForEnd(runId);
    for (const name of ['..%2f..%2fpackage.json', '%2e%2e%2f%2e%2e%2fpackage.json', '..%5c..%5cpackage.json', '__proto__', 'constructor', 'missing.md', 'demo.md%00.txt']) {
      const response = await api.get(`/api/runs/${runId}/files/${name}`);
      assert.equal(response.status, 404, name);
    }
  });

  it('does not serve files of another run', async () => {
    const first = await api.startDemo('first');
    const second = await api.startDemo('second');
    await api.waitForEnd(first);
    await api.waitForEnd(second);
    const body = await (await api.get(`/api/runs/${second}/files/demo.md`)).text();
    assert.match(body, /second/);
  });

  it('replays an identical request from the cache without calling the agents service again', async () => {
    const before = api.agent.calls.length;
    const first = await api.startDemo('cache me');
    const live = await api.waitForEnd(first);
    const calls = api.agent.calls.length;
    assert.equal(calls, before + 1);

    const second = await api.startDemo('  cache   me ');
    const replay = await api.waitForEnd(second);
    assert.equal(api.agent.calls.length, calls);

    const strip = (messages) => messages.map(({ event, data }) => [event, data.nodeId, data.status, data.message]);
    assert.deepEqual(strip(replay), strip(live));
    const body = await (await api.get(`/api/runs/${second}/result`)).json();
    assert.equal(body.cached, true);
    assert.deepEqual(body.files.map((file) => file.name).sort(), ['data.bin', 'demo.md']);
    assert.ok(replay.find((m) => m.event === 'node').data.runId === second);
  });

  it('does not cache failed runs', async () => {
    const first = await api.startDemo('fail');
    const messages = await api.waitForEnd(first);
    assert.deepEqual(messages.at(-1).data, { status: 'error', error: 'Simulated failure' });
    const calls = api.agent.calls.length;
    const second = await api.startDemo('fail');
    await api.waitForEnd(second);
    assert.equal(api.agent.calls.length, calls + 1);
  });

  it('drops events that break the contract and lines that are not JSON', async () => {
    const runId = await api.startDemo('broken');
    const messages = await api.waitForEnd(runId);
    assert.ok(messages.every((m) => m.event === 'end' || m.data.nodeId !== 'not_a_node'));
    assert.equal(messages.at(-1).data.status, 'done');
  });

  it('cancels a running run and closes its stream', async () => {
    const runId = await api.startDemo('slow');
    const stream = api.waitForEnd(runId);
    const response = await api.post(`/api/runs/${runId}/cancel`, {});
    assert.deepEqual(await response.json(), { runId, status: 'cancelled' });
    assert.equal((await stream).at(-1).data.status, 'cancelled');
    // The request to the agents service was aborted, so the agents service can stop the run.
    for (let i = 0; i < 100 && !api.agent.aborted.includes(runId); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(api.agent.aborted.includes(runId));
    assert.equal(api.registry.countActive(), 0);
  });

  const finalStatuses = (runId) => {
    const latest = {};
    for (const { event } of api.registry.get(runId).events) latest[event.nodeId] = event;
    return latest;
  };

  it('does not leave a node running after a cancellation', async () => {
    const runId = await api.startDemo('slow');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await api.post(`/api/runs/${runId}/cancel`, {});
    const active = Object.values(finalStatuses(runId)).filter((event) => event.status === 'running' || event.status === 'waiting');
    assert.deepEqual(active, []);
    assert.ok(Object.values(finalStatuses(runId)).some((event) => event.status === 'skipped' && event.message === 'The run was cancelled.'));
  });

  it('marks the node that was working as failed when the connection is lost', async () => {
    const runId = await api.startDemo('cut');
    await api.waitForEnd(runId);
    const events = Object.values(finalStatuses(runId));
    assert.ok(events.some((event) => event.status === 'error' && event.message === 'The connection to the agents service was lost.'));
    assert.deepEqual(events.filter((event) => event.status === 'running' || event.status === 'waiting'), []);
  });

  it('ends cleanly when the agents service drops the connection in the middle of a run', async () => {
    const runId = await api.startDemo('cut');
    const messages = await api.waitForEnd(runId);
    assert.deepEqual(messages.at(-1).data, { status: 'error', error: 'The connection to the agents service was lost.' });
    assert.equal(api.registry.countActive(), 0);
  });

  it('ends cleanly when the agents service ends the stream without a result', async () => {
    const runId = await api.startDemo('silent');
    const messages = await api.waitForEnd(runId);
    assert.deepEqual(messages.at(-1).data, { status: 'error', error: 'The agents service ended the stream before returning a result.' });
  });

  it('ends cleanly, with the message of the failing node, when the agent reports an error', async () => {
    const runId = await api.startDemo('fail');
    const messages = await api.waitForEnd(runId);
    assert.deepEqual(messages.at(-1).data, { status: 'error', error: 'Simulated failure' });
    assert.ok(messages.some(({ data }) => data.status === 'error' && data.message === 'Simulated failure'));
    assert.equal((await (await api.get(`/api/runs/${runId}/result`)).json()).result, null);
  });

  it('returns JSON 404 for unknown runs, malformed ids and routes', async () => {
    for (const path of ['/api/runs/00000000-0000-4000-8000-000000000000/result', '/api/runs/not-a-uuid/events', '/api/nothing']) {
      const response = await api.get(path);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.code, 'not_found');
    }
  });
});

describe('API: input validation', () => {
  let api;
  before(async () => {
    api = await setup();
  });
  after(() => api.close());

  const problems = async (path, body) => {
    const response = await api.post(path, body);
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.code, 'validation_failed');
    return error.details;
  };

  it('rejects missing and unknown inputs', async () => {
    const details = await problems('/api/projects/demo/runs', { inputs: { extra: 'x' } });
    assert.deepEqual(details.map((d) => d.field).sort(), ['extra', 'topic']);
  });

  it('rejects text that is too long', async () => {
    const details = await problems('/api/projects/demo/runs', { inputs: { topic: 'x'.repeat(201) } });
    assert.equal(details[0].field, 'topic');
  });

  it('rejects URLs that point at internal addresses', async () => {
    const details = await problems('/api/projects/competitor-analysis-crew/runs', {
      inputs: { competitors: ['https://example.com/', 'http://169.254.169.254/latest/meta-data/'] },
    });
    assert.equal(details[0].field, 'competitors');
    assert.equal(api.agent.calls.length, 0);
  });

  it('requires one of the alternatives for the content repurposing project', async () => {
    const details = await problems('/api/projects/content-repurposing-flow/runs', { inputs: {} });
    assert.match(details[0].field, /article_url or article_text or article_file/);
  });

  it('answers 404 for an unknown project', async () => {
    const response = await api.post('/api/projects/nonexistent/runs', { inputs: {} });
    assert.equal(response.status, 404);
  });

  it('rejects invalid JSON and oversized bodies without revealing internals', async () => {
    const invalid = await fetch(`${api.base}/api/projects/demo/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_json');

    const large = await api.post('/api/projects/demo/runs', { inputs: { topic: 'x'.repeat(200_000) } });
    assert.equal(large.status, 413);
    const text = JSON.stringify(await large.json());
    assert.doesNotMatch(text, /node_modules|at \w+ \(/);
  });

  it('lists public projects without the internal demo', async () => {
    const { projects } = await (await api.get('/api/projects')).json();
    assert.equal(projects.length, 10);
    assert.ok(!projects.some((project) => project.id === 'demo'));
  });
});

describe('API: uploads', () => {
  let api;
  before(async () => {
    api = await setup({}, withFilesTest());
  });
  after(() => api.close());

  const createWithFile = async (projectId, files, inputs = {}) => {
    const response = await api.post(`/api/projects/${projectId}/runs`, { inputs, files });
    assert.equal(response.status, 202);
    return response.json();
  };

  it('waits for the declared file, then starts the run with the content in its inputs', async () => {
    const { runId, awaitingFiles } = await createWithFile('files-test', { article: 1 });
    assert.deepEqual(awaitingFiles, { article: 1 });
    assert.equal(api.registry.get(runId).status, 'awaiting_upload');

    const response = await api.upload(runId, 'article', 'article.txt', 'Alice: hello\nBob: hi\n');
    assert.equal(response.status, 201);
    assert.equal((await response.json()).started, true);

    const messages = await api.waitForEnd(runId);
    assert.equal(messages.at(-1).data.status, 'done');
    const call = api.agent.calls.find((entry) => entry.runId === runId);
    assert.deepEqual(call.inputs.article, [
      { filename: 'article.txt', contentType: 'text/plain', encoding: 'utf8', content: 'Alice: hello\nBob: hi\n' },
    ]);
  });

  it('starts only after every declared file has arrived', async () => {
    const { runId } = await createWithFile(
      'resume-screening-flow',
      { resumes: 2 },
      { job_description: 'We are hiring a data engineer with SQL experience.' },
    );
    const first = await api.upload(runId, 'resumes', 'a.txt', 'Candidate A has experience in data analysis.');
    assert.equal((await first.json()).started, false);
    assert.equal(api.registry.get(runId).status, 'awaiting_upload');
    const second = await api.upload(runId, 'resumes', 'b.txt', 'Candidate B has experience in reporting work.');
    assert.equal((await second.json()).started, true);
    const third = await api.upload(runId, 'resumes', 'c.txt', 'Candidate C has experience in finance roles.');
    assert.equal(third.status, 409);
  });

  it('rejects an extension the input does not accept', async () => {
    const { runId } = await createWithFile('files-test', { article: 1 });
    for (const name of ['article.exe', 'article.pdf', 'article.html', 'article.csv', 'article']) {
      const response = await api.upload(runId, 'article', name, 'a,b\n1,2\n');
      assert.equal(response.status, 415, name);
    }
  });

  it('checks the file signature and not only the extension', async () => {
    const { runId } = await createWithFile('resume-screening-flow', { resumes: 3 }, { job_description: 'We are hiring a data engineer.' });
    const fakePdf = await api.upload(runId, 'resumes', 'cv.pdf', 'plain text, not a PDF');
    assert.equal(fakePdf.status, 415);
    assert.equal((await fakePdf.json()).error.code, 'bad_signature');

    const binaryAsText = await api.upload(runId, 'resumes', 'cv.txt', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]));
    assert.equal(binaryAsText.status, 415);

    const invalidUtf8 = await api.upload(runId, 'resumes', 'cv.txt', Buffer.from([0xc3, 0x28, 0x41]));
    assert.equal(invalidUtf8.status, 415);

    const realPdf = await api.upload(runId, 'resumes', 'cv.pdf', makePdf(['A real one-page document made up for testing purposes.']), 'application/pdf');
    assert.equal(realPdf.status, 201);
  });


  it('enforces the size limit', async () => {
    const { runId } = await createWithFile('files-test', { article: 1 });
    const response = await api.upload(runId, 'article', 'big.txt', 'x'.repeat(2001));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'file_too_large');
  });

  it('rejects unknown fields, empty files and path-like names safely', async () => {
    const { runId } = await createWithFile('files-test', { article: 1 });
    assert.equal((await api.upload(runId, 'nonsense', 't.txt', 'x')).status, 400);
    assert.equal((await api.upload(runId, 'article', 't.txt', '')).status, 400);
    const response = await api.upload(runId, 'article', '../../etc/passwd.txt', 'content');
    assert.equal(response.status, 201);
    assert.equal((await response.json()).filename, 'passwd.txt');
  });

  it('rejects uploads to unknown runs and to runs that are not waiting', async () => {
    assert.equal((await api.upload('00000000-0000-4000-8000-000000000000', 'article', 't.txt', 'x')).status, 404);
    const runId = await api.startDemo('upload-late');
    assert.equal((await api.upload(runId, 'article', 't.txt', 'x')).status, 409);
  });

  it('refuses a run that declares too many files', async () => {
    const response = await api.post('/api/projects/files-test/runs', { inputs: {}, files: { article: 2 } });
    assert.equal(response.status, 400);
  });
});

describe('API: limits', () => {
  it('limits runs per address', async () => {
    const api = await setup({ rateLimitRuns: 3 });
    try {
      for (let i = 0; i < 3; i += 1) assert.equal((await api.post('/api/projects/demo/runs', { inputs: { topic: `t${i}` } })).status, 202);
      const blocked = await api.post('/api/projects/demo/runs', { inputs: { topic: 't4' } });
      assert.equal(blocked.status, 429);
      assert.equal((await blocked.json()).error.code, 'rate_limited');
    } finally {
      await api.close();
    }
  });

  it('limits simultaneous runs but still serves cached results', async () => {
    const api = await setup({ maxConcurrentRuns: 1 });
    try {
      const finished = await api.startDemo('warm');
      await api.waitForEnd(finished);

      const slow = await api.startDemo('slow');
      const refused = await api.post('/api/projects/demo/runs', { inputs: { topic: 'another' } });
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get('retry-after'), '30');
      assert.equal((await refused.json()).error.code, 'at_capacity');

      const cached = await api.startDemo('warm');
      assert.equal((await api.waitForEnd(cached)).at(-1).data.status, 'done');
      await api.post(`/api/runs/${slow}/cancel`, {});
    } finally {
      await api.close();
    }
  });

  it('ends a run that exceeds the timeout', async () => {
    const api = await setup({ agentTimeoutMs: 150 });
    try {
      const runId = await api.startDemo('slow');
      const messages = await api.waitForEnd(runId);
      assert.deepEqual(messages.at(-1).data, { status: 'error', error: 'The run exceeded the permitted time.' });
    } finally {
      await api.close();
    }
  });

  it('reports an unreachable agents service as a failed run', async () => {
    const api = await setup({ agentsUrl: 'http://127.0.0.1:1' });
    try {
      const messages = await api.waitForEnd(await api.startDemo('anything'));
      assert.equal(messages.at(-1).data.status, 'error');
      assert.match(messages.at(-1).data.error, /connection to the agents service was lost/);
    } finally {
      await api.close();
    }
  });

  it('reports a rejected secret as a failed run without exposing the response', async () => {
    const api = await setup({ agentSecret: 'wrong' });
    try {
      const messages = await api.waitForEnd(await api.startDemo('anything'));
      assert.equal(messages.at(-1).data.status, 'error');
      assert.match(messages.at(-1).data.error, /status 401/);
    } finally {
      await api.close();
    }
  });
});

describe('API: a transcript pasted or uploaded reaches the agents service as one text input', () => {
  let api;
  before(async () => {
    api = await setup();
  });
  after(() => api.close());

  const TRANSCRIPT = 'Priya: I will update the onboarding guide by Friday. Tom: Agreed, thank you.';

  it('passes pasted text through unchanged', async () => {
    const response = await api.post('/api/projects/meeting-notes-crew/runs', { inputs: { transcript: TRANSCRIPT } });
    assert.equal(response.status, 202);
    const { runId, awaitingFiles } = await response.json();
    assert.deepEqual(awaitingFiles, {});
    await api.waitForEnd(runId);
    const call = api.agent.calls.find((entry) => entry.runId === runId);
    assert.deepEqual(call.inputs, { transcript: TRANSCRIPT });
  });

  it('extracts the text of an uploaded .txt file and passes it as the transcript, without the file', async () => {
    const text = `${TRANSCRIPT} (from a file)`;
    const created = await api.post('/api/projects/meeting-notes-crew/runs', { inputs: {}, files: { transcript_file: 1 } });
    assert.equal(created.status, 202);
    const { runId } = await created.json();
    const uploaded = await api.upload(runId, 'transcript_file', 'meeting.txt', `  ${text}

`);
    assert.equal(uploaded.status, 201);
    await api.waitForEnd(runId);
    const call = api.agent.calls.find((entry) => entry.runId === runId);
    assert.deepEqual(call.inputs, { transcript: text });
  });

  it('uses the file when text is pasted as well', async () => {
    const text = `${TRANSCRIPT} (file wins)`;
    const created = await api.post('/api/projects/meeting-notes-crew/runs', {
      inputs: { transcript: 'Pasted text that should be replaced by the uploaded file text.' },
      files: { transcript_file: 1 },
    });
    const { runId } = await created.json();
    await api.upload(runId, 'transcript_file', 'meeting.txt', text);
    await api.waitForEnd(runId);
    assert.equal(api.agent.calls.find((entry) => entry.runId === runId).inputs.transcript, text);
  });

  it('treats pasted and uploaded text alike, so the second request is served from the cache', async () => {
    const text = `${TRANSCRIPT} (cache check)`;
    const pasted = await (await api.post('/api/projects/meeting-notes-crew/runs', { inputs: { transcript: text } })).json();
    await api.waitForEnd(pasted.runId);
    const calls = api.agent.calls.length;
    const created = await (await api.post('/api/projects/meeting-notes-crew/runs', { inputs: {}, files: { transcript_file: 1 } })).json();
    await api.upload(created.runId, 'transcript_file', 'm.txt', text);
    await api.waitForEnd(created.runId);
    assert.equal(api.agent.calls.length, calls);
    assert.equal(api.registry.get(created.runId).cached, true);
  });

  it('refuses a file whose text is longer than the transcript limit, and keeps waiting for a valid one', async () => {
    const roomy = await setup({ uploadMaxBytes: 100_000 });
    try {
      const made = await (await roomy.post('/api/projects/meeting-notes-crew/runs', { inputs: {}, files: { transcript_file: 1 } })).json();
      const response = await roomy.upload(made.runId, 'transcript_file', 'long.txt', 'word '.repeat(7000));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'text_too_long');
      assert.equal(roomy.registry.get(made.runId).status, 'awaiting_upload');
    } finally {
      await roomy.close();
    }
  });

  it('refuses a file with too little text', async () => {
    const created = await api.post('/api/projects/meeting-notes-crew/runs', { inputs: {}, files: { transcript_file: 1 } });
    const { runId } = await created.json();
    const response = await api.upload(runId, 'transcript_file', 'tiny.txt', 'Too short.');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'text_too_short');
  });

  it('requires either pasted text or a file', async () => {
    const response = await api.post('/api/projects/meeting-notes-crew/runs', { inputs: {} });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify((await response.json()).error.details), /one of these is required/);
  });
});

describe('API: a CSV upload reaches the agents service as text', () => {
  let api;
  before(async () => {
    api = await setup({ uploadMaxBytes: 2 * 1024 * 1024 });
  });
  after(() => api.close());

  const CSV = 'date,region,revenue\n2026-01-01,North,120.5\n2026-01-02,South,98\n';

  it('passes the content of the .csv file as the csv input, and no file', async () => {
    const created = await api.post('/api/projects/data-report-crew/runs', { inputs: {}, files: { sales: 1 } });
    assert.equal(created.status, 202);
    const { runId } = await created.json();
    const uploaded = await api.upload(runId, 'sales', 'sales.csv', CSV, 'text/csv');
    assert.equal(uploaded.status, 201);
    await api.waitForEnd(runId);
    const call = api.agent.calls.find((entry) => entry.runId === runId);
    assert.deepEqual(call.inputs, { csv: CSV.trim() });
  });

  it('refuses a file that is not a .csv file', async () => {
    const created = await (await api.post('/api/projects/data-report-crew/runs', { inputs: {}, files: { sales: 1 } })).json();
    assert.equal((await api.upload(created.runId, 'sales', 'sales.txt', CSV)).status, 415);
  });

  it('requires the file', async () => {
    const response = await api.post('/api/projects/data-report-crew/runs', { inputs: {} });
    assert.equal(response.status, 400);
  });
});

describe('API: resumes are extracted to plain text before they reach the agents service', () => {
  let api;
  before(async () => {
    api = await setup({ uploadMaxBytes: 2 * 1024 * 1024 });
  });
  after(() => api.close());

  const JOB = 'We are looking for a data analyst with SQL and Python experience.';
  const TXT = 'Sample Candidate One. Skills: SQL, Python, dashboards. Five years of analysis experience.';
  const PDF_LINES = ['Sample Candidate Two', 'Skills: Excel and reporting', 'Two years of experience in finance'];

  async function createRun(count) {
    const response = await api.post('/api/projects/resume-screening-flow/runs', { inputs: { job_description: JOB }, files: { resumes: count } });
    assert.equal(response.status, 202);
    return (await response.json()).runId;
  }

  it('passes .txt and .pdf resumes as plain text and never as files', async () => {
    const runId = await createRun(2);
    assert.equal((await api.upload(runId, 'resumes', 'one.txt', TXT)).status, 201);
    const pdf = await api.upload(runId, 'resumes', 'two.pdf', makePdf(PDF_LINES), 'application/pdf');
    assert.equal(pdf.status, 201);
    await api.waitForEnd(runId);

    const { inputs } = api.agent.calls.find((entry) => entry.runId === runId);
    assert.equal(inputs.job_description, JOB);
    assert.equal(inputs.resumes.length, 2);
    assert.deepEqual(inputs.resumes[0], { name: 'one.txt', text: TXT });
    assert.equal(inputs.resumes[1].name, 'two.pdf');
    for (const line of PDF_LINES) assert.ok(inputs.resumes[1].text.includes(line), line);
    // Nothing that looks like a raw file is passed on.
    assert.ok(!JSON.stringify(inputs).includes('base64'));
    assert.ok(inputs.resumes.every((item) => Object.keys(item).sort().join() === 'name,text'));
    assert.ok(!JSON.stringify(inputs).includes('%PDF'));
  });

  it('refuses a scanned (text-less) PDF with a clear message, and keeps waiting', async () => {
    const runId = await createRun(1);
    const response = await api.upload(runId, 'resumes', 'scan.pdf', makePdf([]), 'application/pdf');
    assert.equal(response.status, 422);
    const { error } = await response.json();
    assert.equal(error.code, 'no_text');
    assert.match(error.message, /scanned document is an image/);
    assert.equal(api.registry.get(runId).status, 'awaiting_upload');
  });

  it('refuses a damaged PDF', async () => {
    const runId = await createRun(1);
    const response = await api.upload(runId, 'resumes', 'bad.pdf', Buffer.from('%PDF-1.4\nnot a document\n'), 'application/pdf');
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'unreadable_pdf');
  });

  it('refuses a file that is a PDF in name only', async () => {
    const runId = await createRun(1);
    const response = await api.upload(runId, 'resumes', 'fake.pdf', 'plain text, not a PDF', 'application/pdf');
    assert.equal(response.status, 415);
  });

  it('accepts one to five resumes and no more', async () => {
    const six = await api.post('/api/projects/resume-screening-flow/runs', { inputs: { job_description: JOB }, files: { resumes: 6 } });
    assert.equal(six.status, 400);
    const none = await api.post('/api/projects/resume-screening-flow/runs', { inputs: { job_description: JOB } });
    assert.equal(none.status, 400);
  });

  it('starts only after every resume has been read', async () => {
    const runId = await createRun(2);
    const first = await (await api.upload(runId, 'resumes', 'a.txt', TXT)).json();
    assert.equal(first.started, false);
    const second = await (await api.upload(runId, 'resumes', 'b.txt', `${TXT} Second candidate.`)).json();
    assert.equal(second.started, true);
  });
});

describe('API: all output files as one zip download', () => {
  let api;
  before(async () => {
    api = await setup();
  });
  after(() => api.close());

  it('offers a zip when a run produced more than one file', async () => {
    const runId = await api.startDemo('zip me');
    await api.waitForEnd(runId);
    const body = await (await api.get(`/api/runs/${runId}/result`)).json();
    assert.equal(body.zipUrl, `/api/runs/${runId}/files.zip`);
  });

  it('serves every registered file inside the archive, with safe headers', async () => {
    const runId = await api.startDemo('zip content');
    await api.waitForEnd(runId);
    const response = await api.get(`/api/runs/${runId}/files.zip`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="demo-files.zip"');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    assert.deepEqual(Object.keys(entries).sort(), ['data.bin', 'demo.md']);
    assert.equal(Buffer.from(entries['demo.md']).toString(), '# Result\n\nTopic: zip content\n');
    assert.deepEqual([...entries['data.bin']], [1, 2, 3, 4]);
  });

  it('is not available while the run is still going', async () => {
    const runId = await api.startDemo('slow');
    const response = await api.get(`/api/runs/${runId}/files.zip`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'not_finished');
    await api.post(`/api/runs/${runId}/cancel`, {});
  });

  it('answers 404 when the run produced no files, and for an unknown run', async () => {
    const failed = await api.startDemo('fail');
    await api.waitForEnd(failed);
    assert.equal((await api.get(`/api/runs/${failed}/files.zip`)).status, 404);
    assert.equal((await api.get('/api/runs/00000000-0000-4000-8000-000000000000/files.zip')).status, 404);
  });

  it('does not offer a zip for a single file', async () => {
    const runId = await api.startDemo('single');
    await api.waitForEnd(runId);
    api.registry.get(runId).files = Object.fromEntries(Object.entries(api.registry.get(runId).files).slice(0, 1));
    assert.equal((await (await api.get(`/api/runs/${runId}/result`)).json()).zipUrl, null);
  });
});

describe('API: an article is an address, pasted text or a file', () => {
  let api;
  before(async () => {
    api = await setup({ uploadMaxBytes: 2 * 1024 * 1024 });
  });
  after(() => api.close());

  const ARTICLE = `${'Vertical farms grow crops indoors in stacked layers. '.repeat(8)}`;

  it('passes pasted text and an address through as they are', async () => {
    const pasted = await (await api.post('/api/projects/content-repurposing-flow/runs', { inputs: { article_text: ARTICLE } })).json();
    await api.waitForEnd(pasted.runId);
    assert.deepEqual(api.agent.calls.find((c) => c.runId === pasted.runId).inputs, { article_text: ARTICLE.trim() });

    const linked = await (await api.post('/api/projects/content-repurposing-flow/runs', { inputs: { article_url: 'https://example.com/post' } })).json();
    await api.waitForEnd(linked.runId);
    assert.deepEqual(api.agent.calls.find((c) => c.runId === linked.runId).inputs, { article_url: 'https://example.com/post' });
  });

  it('reads an uploaded .txt file as the article text', async () => {
    const created = await (await api.post('/api/projects/content-repurposing-flow/runs', { inputs: {}, files: { article_file: 1 } })).json();
    const text = `${ARTICLE} (from a file)`;
    assert.equal((await api.upload(created.runId, 'article_file', 'article.txt', text)).status, 201);
    await api.waitForEnd(created.runId);
    assert.deepEqual(api.agent.calls.find((c) => c.runId === created.runId).inputs, { article_text: text.trim() });
  });

  it('refuses an address that points at an internal host', async () => {
    const response = await api.post('/api/projects/content-repurposing-flow/runs', { inputs: { article_url: 'http://169.254.169.254/latest/meta-data/' } });
    assert.equal(response.status, 400);
  });

  it('refuses pasted text that is too short and an empty request', async () => {
    assert.equal((await api.post('/api/projects/content-repurposing-flow/runs', { inputs: { article_text: 'Too short.' } })).status, 400);
    assert.equal((await api.post('/api/projects/content-repurposing-flow/runs', { inputs: {} })).status, 400);
  });
});
