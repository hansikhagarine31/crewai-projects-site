import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRunRegistry } from '../src/runs.js';

const event = (nodeId, status = 'running') => ({ runId: 'x', nodeId, status, message: '', ts: 1 });

function registryWithClock(options = {}) {
  const clock = { time: 1_000 };
  const registry = createRunRegistry({ ...options, now: () => clock.time });
  return { registry, clock };
}

describe('run registry', () => {
  it('creates runs with unique ids and the documented shape', () => {
    const { registry } = registryWithClock();
    const a = registry.createRun('demo', { topic: 'a' });
    const b = registry.createRun('demo', { topic: 'b' });
    assert.notEqual(a, b);
    const run = registry.get(a);
    assert.equal(run.projectId, 'demo');
    assert.deepEqual(run.inputs, { topic: 'a' });
    assert.equal(run.status, 'running');
    assert.deepEqual(run.events, []);
    assert.equal(run.result, null);
    assert.deepEqual(Object.keys(run.files), []);
  });

  it('appends events with increasing sequence numbers', () => {
    const { registry } = registryWithClock();
    const id = registry.createRun('demo', {});
    registry.emit(id, event('a'));
    registry.emit(id, event('b'));
    assert.deepEqual(registry.get(id).events.map((entry) => entry.seq), [1, 2]);
  });

  it('caps history per run and keeps sequence numbers increasing', () => {
    const { registry } = registryWithClock({ maxEventsPerRun: 3 });
    const id = registry.createRun('demo', {});
    for (let i = 0; i < 5; i += 1) registry.emit(id, event(`n${i}`));
    const run = registry.get(id);
    assert.deepEqual(run.events.map((entry) => entry.seq), [3, 4, 5]);
    assert.equal(run.events[0].event.nodeId, 'n2');
  });

  it('notifies subscribers of events and of the end, and stops after unsubscribe', () => {
    const { registry } = registryWithClock();
    const id = registry.createRun('demo', {});
    const seen = [];
    const unsubscribe = registry.subscribe(id, (message) => seen.push(message.type));
    registry.emit(id, event('a'));
    unsubscribe();
    registry.emit(id, event('b'));
    assert.deepEqual(seen, ['event']);

    registry.subscribe(id, (message) => seen.push(message.type === 'end' ? `end:${message.status}` : message.type));
    registry.finish(id, 'done');
    assert.deepEqual(seen, ['event', 'end:done']);
  });

  it('finishes only once', () => {
    const { registry } = registryWithClock();
    const id = registry.createRun('demo', {});
    let ends = 0;
    registry.subscribe(id, (message) => {
      if (message.type === 'end') ends += 1;
    });
    registry.finish(id, 'cancelled');
    registry.finish(id, 'done');
    assert.equal(ends, 1);
    assert.equal(registry.get(id).status, 'cancelled');
  });

  it('counts only running runs that use the agents service', () => {
    const { registry } = registryWithClock();
    const running = registry.createRun('demo', {});
    registry.createRun('demo', {}, { status: 'awaiting_upload' });
    const cached = registry.createRun('demo', {}, { cached: true });
    const finished = registry.createRun('demo', {});
    registry.finish(finished, 'done');
    assert.equal(registry.countActive(), 1);
    assert.ok(running && cached);
  });

  it('expires finished runs after the configured time but keeps unfinished ones', () => {
    const { registry, clock } = registryWithClock({ runTtlMs: 5_000 });
    const finished = registry.createRun('demo', {});
    const running = registry.createRun('demo', {});
    registry.finish(finished, 'done');

    clock.time += 4_999;
    registry.sweep();
    assert.ok(registry.get(finished));

    clock.time += 2;
    registry.sweep();
    assert.equal(registry.get(finished), undefined);
    assert.ok(registry.get(running));
  });

  it('cancels uploads that are never completed, then expires them', () => {
    const { registry, clock } = registryWithClock({ awaitingUploadTtlMs: 1_000, runTtlMs: 1_000 });
    const id = registry.createRun('demo', {}, { status: 'awaiting_upload' });
    clock.time += 1_001;
    registry.sweep();
    assert.equal(registry.get(id).status, 'cancelled');
    clock.time += 1_001;
    registry.sweep();
    assert.equal(registry.get(id), undefined);
  });

  it('stores output files and enforces the total size limit', () => {
    const { registry } = registryWithClock({ maxOutputBytes: 10 });
    const id = registry.createRun('demo', {});
    registry.addFile(id, 'a.md', { content: Buffer.alloc(6), contentType: 'text/markdown' });
    assert.equal(registry.get(id).files['a.md'].size, 6);
    assert.throws(() => registry.addFile(id, 'b.md', { content: Buffer.alloc(5), contentType: 'text/markdown' }), /exceed/);
    registry.addFile(id, 'a.md', { content: Buffer.alloc(9), contentType: 'text/markdown' });
    assert.equal(registry.get(id).outputBytes, 9);
  });

  it('does not let a file named __proto__ alter the prototype', () => {
    const { registry } = registryWithClock();
    const id = registry.createRun('demo', {});
    registry.addFile(id, '__proto__', { content: Buffer.from('x'), contentType: 'text/plain' });
    const { files } = registry.get(id);
    assert.equal(Object.getPrototypeOf(files), null);
    assert.equal(Object.hasOwn(files, '__proto__'), true);
    assert.equal(Object.hasOwn(files, 'toString'), false);
  });
});
