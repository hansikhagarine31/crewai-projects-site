// Contract: node ids in shared/projects.json, frontend/src/data/projects.js and the events that the Python runner emits
// (recorded in shared/event-logs by the agents tests) are exactly the same, for every project.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { compareNodeIds } from './compare.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = JSON.parse(readFileSync(path.join(root, 'shared', 'projects.json'), 'utf8'));
const { projects: frontendProjects, demoProject } = await import(pathToFileURL(path.join(root, 'frontend', 'src', 'data', 'projects.js')).href);
const frontend = new Map([...frontendProjects, demoProject].map((project) => [project.id, project]));
const STATUSES = new Set(shared.statuses);

describe('compareNodeIds', () => {
  const sets = (a, b, c) => ({ shared: new Set(a), frontend: new Set(b), 'Python events': new Set(c) });

  it('accepts identical sets', () => {
    assert.deepEqual(compareNodeIds('p', sets(['a', 'b'], ['b', 'a'], ['a', 'b'])), []);
  });

  it('fails on an id that the Python runner never emits', () => {
    const problems = compareNodeIds('p', sets(['a', 'b'], ['a', 'b'], ['a']));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /"b" is in shared, frontend but missing from Python events/);
  });

  it('fails on an unknown id emitted by the Python runner', () => {
    const problems = compareNodeIds('p', sets(['a'], ['a'], ['a', 'z']));
    assert.match(problems[0], /"z" is in Python events but missing from shared, frontend/);
  });

  it('fails on an id missing from the frontend', () => {
    assert.match(compareNodeIds('p', sets(['a', 'b'], ['a'], ['a', 'b']))[0], /missing from frontend/);
  });
});

describe('node ids agree across shared/projects.json, the frontend data and the Python event logs', () => {
  it('every shared project has frontend data and an event log, and no other project does', () => {
    const ids = shared.projects.map((project) => project.id).sort();
    assert.deepEqual([...frontend.keys()].sort(), ids);
    for (const id of ids) assert.ok(existsSync(path.join(root, 'shared', 'event-logs', `${id}.json`)), `shared/event-logs/${id}.json is missing; run the agents tests with RECORD_EVENTS=1`);
  });

  for (const project of shared.projects) {
    it(project.id, () => {
      const log = JSON.parse(readFileSync(path.join(root, 'shared', 'event-logs', `${project.id}.json`), 'utf8'));
      const sources = {
        shared: new Set(project.nodes.map((node) => node.nodeId)),
        frontend: new Set(frontend.get(project.id).nodes.map((node) => node.id)),
        'Python events': new Set(Object.keys(log.emitted)),
      };
      assert.deepEqual(compareNodeIds(project.id, sources), []);
      for (const [node, statuses] of Object.entries(log.emitted)) {
        for (const status of statuses) assert.ok(STATUSES.has(status), `${project.id}: ${node} was emitted with the unknown status "${status}"`);
      }
    });
  }
});
