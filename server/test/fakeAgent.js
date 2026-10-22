import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { getProject as realGetProject } from '../src/projects.js';

/**
 * A stand-in for the Python agents service. It speaks the same protocol:
 * POST /run/{projectId} streams newline-delimited JSON, one object per line.
 *
 * Behaviour is driven by the "topic" input so tests can exercise failure paths:
 *   "fail"   emits an error line after the first node
 *   "slow"   waits between events, so cancellation and timeouts can be tested
 *   "cut"    drops the connection after the first node; "silent" ends the stream without a result
 *   "broken" emits an invalid event and a line that is not JSON, then completes
 *
 * The "approval-report-flow" project behaves like the real one: the first part ends with a "waiting" line and the
 * run's state is stored; POST /resume/{runId} continues it (approved: a result; revise: another draft, up to three
 * times, then a result without approval); DELETE /state/{runId} forgets it. Topic "slow" makes a resumed part slow.
 */
export function createFakeAgent({ secret = 'test-secret', delayMs = 20, getProject = realGetProject } = {}) {
  const calls = [];
  const stored = new Map(); // runId -> { topic, revisions }
  const resumes = [];
  const deleted = [];
  const expired = new Set(); // run ids that answer a resume with 410
  const aborted = []; // run ids whose connection was closed by the caller before the response ended
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


  const event = (runId, nodeId, status, message) => ({ type: 'event', runId, nodeId, status, message, ts: Date.now() });
  const waitingLine = (runId, state) => ({
    type: 'waiting',
    message: 'Waiting for a decision',
    review: {
      draft: `# Draft ${state.revisions + 1}\n\nTopic: ${state.topic}\n`,
      round: state.revisions + 1,
      revisionsUsed: state.revisions,
      revisionsLeft: 3 - state.revisions,
      maxRevisions: 3,
      notes: [],
    },
  });

  async function firstPart(res, send, runId, topic) {
    for (const nodeId of ['collect_topic', 'research_crew', 'writing_crew']) {
      send(event(runId, nodeId, 'running', `Starting ${nodeId}`));
      await sleep(delayMs);
      send(event(runId, nodeId, 'done', `Finished ${nodeId}`));
    }
    const state = { topic, revisions: 0 };
    stored.set(runId, state);
    send(event(runId, 'review_draft', 'waiting', 'Waiting for your decision on draft 1'));
    send(waitingLine(runId, state));
    return res.end();
  }

  async function resume(req, res, runId) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { decision, feedback } = JSON.parse(raw);
    resumes.push({ runId, decision, feedback });
    if (expired.has(runId)) {
      res.statusCode = 410;
      return res.end('{"detail":"The run waited too long."}');
    }
    const state = stored.get(runId);
    if (!state) {
      res.statusCode = 404;
      return res.end('{"detail":"No stored run."}');
    }
    res.setHeader('content-type', 'application/x-ndjson');
    const send = (object) => res.write(`${JSON.stringify(object)}\n`);
    send(event(runId, 'review_draft', 'done', 'Decision received'));
    send(event(runId, 'check_decision', 'running', 'Checking the decision'));
    if (state.topic === 'slow') await sleep(5000);
    if (decision === 'approved') {
      send(event(runId, 'check_decision', 'done', 'Route: approved'));
      send(event(runId, 'publish_report', 'done', 'final.md saved'));
      send({ type: 'file', name: 'final.md', encoding: 'utf-8', content: `# Final\n\nRevisions: ${state.revisions}\n` });
      send({ type: 'result', markdown: `# Final\n\nRevisions: ${state.revisions}\n` });
      stored.delete(runId);
      return res.end();
    }
    if (state.revisions >= 3) {
      send(event(runId, 'check_decision', 'done', 'Revision limit reached (3 rounds)'));
      send({ type: 'result', markdown: '# Draft not approved\n\nThe limit of 3 revision rounds has been reached.\n' });
      stored.delete(runId);
      return res.end();
    }
    send(event(runId, 'check_decision', 'done', 'Route: revise'));
    send(event(runId, 'revision_crew', 'done', `Revision ${state.revisions + 1} written`));
    state.revisions += 1;
    send(event(runId, 'review_draft', 'waiting', `Waiting for your decision on draft ${state.revisions + 1}`));
    send(waitingLine(runId, state));
    return res.end();
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (req.headers['x-agent-secret'] !== secret) {
      res.statusCode = 401;
      return res.end('{"detail":"Invalid or missing x-agent-secret header."}');
    }

    const stateMatch = req.url.match(/^\/state\/([^/]+)$/);
    if (req.method === 'DELETE' && stateMatch) {
      deleted.push(decodeURIComponent(stateMatch[1]));
      stored.delete(decodeURIComponent(stateMatch[1]));
      res.statusCode = 204;
      return res.end();
    }

    const resumeMatch = req.url.match(/^\/resume\/([^/]+)$/);
    if (req.method === 'POST' && resumeMatch) return resume(req, res, decodeURIComponent(resumeMatch[1]));

    const match = req.url.match(/^\/run\/([^/]+)$/);
    const project = match && getProject(decodeURIComponent(match[1]));
    if (req.method !== 'POST' || !project) {
      res.statusCode = 404;
      return res.end('{"detail":"Not Found"}');
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { runId, inputs } = JSON.parse(raw);
    calls.push({ projectId: project.id, runId, inputs });

    res.setHeader('content-type', 'application/x-ndjson');
    const send = (object) => res.write(`${JSON.stringify(object)}\n`);
    const topic = String(inputs.topic ?? '');
    if (project.id === 'approval-report-flow') return firstPart(res, send, runId, topic);
    let closed = false;
    res.on('close', () => {
      closed = true;
      if (!res.writableEnded) aborted.push(runId);
    });

    const nodes = project.nodes.filter((node) => node.kind !== 'join');
    for (const [index, node] of nodes.entries()) {
      if (closed) return;
      const wait = topic === 'slow' ? 5000 : delayMs;
      send({ type: 'event', runId, nodeId: node.nodeId, status: 'running', message: `Starting ${node.name}`, ts: Date.now() });
      await sleep(wait);
      if (topic === 'broken' && index === 0) {
        send({ type: 'event', runId, nodeId: 'not_a_node', status: 'running', message: 'x', ts: 1 });
        res.write('this line is not json\n');
      }
      if (topic === 'cut' && index === 1) return res.destroy(); // the connection drops in the middle of a run
      if (topic === 'silent' && index === 1) return res.end(); // the stream ends without a result or an error
      if (topic === 'fail' && index === 1) {
        send({ type: 'event', runId, nodeId: node.nodeId, status: 'error', message: 'Simulated failure', ts: Date.now() });
        send({ type: 'error', message: 'Simulated failure' });
        return res.end();
      }
      send({ type: 'event', runId, nodeId: node.nodeId, status: 'done', message: `Finished ${node.name}`, ts: Date.now() });
    }

    send({ type: 'file', name: 'demo.md', encoding: 'utf-8', content: `# Result\n\nTopic: ${topic}\n` });
    send({ type: 'file', name: 'data.bin', encoding: 'base64', content: Buffer.from([1, 2, 3, 4]).toString('base64') });
    send({ type: 'result', markdown: `# Completed ${project.id}\n\nTopic: ${topic}\n` });
    return res.end();
  });

  return { server, calls, stored, resumes, deleted, expired, aborted };
}

// Run directly (node test/fakeAgent.js) to use it as a stand-in on port 8001.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_AGENT_PORT ?? 8001);
  const { server } = createFakeAgent({ secret: process.env.AGENT_SHARED_SECRET ?? 'dev-secret-local', delayMs: 300 });
  server.listen(port, '127.0.0.1', () => console.log(`Fake agent listening on ${port}`));
}
