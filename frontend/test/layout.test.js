import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { getProject, projects } from '../src/data/projects.js';
import { computeLayout, GEOMETRY } from '../src/lib/layout.js';
import { applyEnd, applyEvent, initialRunState, statusOf } from '../src/lib/runState.js';

describe('computeLayout', () => {
  it('reproduces the reference dimensions for projects without group labels', () => {
    // The reference draws project 1 in a 950 x 102 box (5 columns, 1 row).
    const layout = computeLayout(getProject('blog-post-crew'));
    assert.equal(layout.width, 950);
    assert.equal(layout.height, 102);
    assert.deepEqual(layout.nodes.map((node) => node.x), [12, 206, 400, 594, 788]);
  });

  it('reproduces the reference geometry of the router flow (project 5)', () => {
    const layout = computeLayout(getProject('customer-support-flow'));
    const node = (id) => layout.nodes.find((entry) => entry.id === id);
    assert.equal(layout.width, 1144);
    // Reference: handle_billing at (594, 12), join pill at (821, 136) 84 x 30, resolve_ticket at (982, 112).
    // The group label band shifts every y by 18.
    assert.deepEqual([node('handle_billing').x, node('handle_billing').y - GEOMETRY.labelBand], [594, 12]);
    assert.deepEqual([node('or_').x, node('or_').y - GEOMETRY.labelBand, node('or_').w, node('or_').h], [821, 136, 84, 30]);
    assert.deepEqual([node('resolve_ticket').x, node('resolve_ticket').y - GEOMETRY.labelBand], [982, 112]);
  });

  it('draws fan-out and merge connectors through a trunk 22 units after the source column', () => {
    const layout = computeLayout(getProject('competitor-analysis-crew'));
    const toScraper = layout.edges.find((edge) => edge.key === 'manager>site_scraper');
    // Reference: the trunk is at x = 378 (356 + 22).
    assert.match(toScraper.d, /L378 /);
    const merge = layout.edges.find((edge) => edge.key === 'site_scraper>strategist');
    assert.match(merge.d, /L572 /); // 550 + 22
    const straight = layout.edges.find((edge) => edge.key === 'input>manager');
    assert.equal((straight.d.match(/L/g) ?? []).length, 1);
  });

  it('draws one arrowhead where several connectors meet the same port', () => {
    const layout = computeLayout(getProject('customer-support-flow'));
    const intoJoin = layout.arrows.filter((arrow) => arrow.to === 'or_');
    assert.equal(intoJoin.length, 1);
  });

  it('keeps every node, label and connector point inside the viewBox', () => {
    for (const project of projects) {
      const layout = computeLayout(project);
      for (const node of layout.nodes) {
        assert.ok(node.x >= 0 && node.x + node.w <= layout.width, `${project.id}/${node.id} horizontally`);
        assert.ok(node.y >= 0 && node.y + node.h <= layout.height, `${project.id}/${node.id} vertically`);
      }
      for (const label of layout.groupLabels) assert.ok(label.y >= 8, `${project.id} group label`);
    }
  });

  it('does not overlap nodes', () => {
    for (const project of projects) {
      const { nodes } = computeLayout(project);
      for (const a of nodes) {
        for (const b of nodes) {
          if (a.id >= b.id) continue;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          assert.ok(apart, `${project.id}: ${a.id} overlaps ${b.id}`);
        }
      }
    }
  });
});

describe('run state', () => {
  const event = (nodeId, status) => ({ runId: 'r', nodeId, status, message: '', ts: 1 });

  it('keeps the latest status per node', () => {
    let state = initialRunState();
    state = applyEvent(state, 1, event('a', 'running'));
    state = applyEvent(state, 2, event('a', 'done'));
    state = applyEvent(state, 3, event('b', 'running'));
    assert.deepEqual(state.statuses, { a: 'done', b: 'running' });
    assert.equal(state.lastSeq, 3);
  });

  it('ignores events replayed after a reconnection', () => {
    let state = applyEvent(initialRunState(), 1, event('a', 'running'));
    state = applyEvent(state, 2, event('a', 'done'));
    const again = applyEvent(applyEvent(state, 1, event('a', 'running')), 2, event('a', 'done'));
    assert.equal(again, state);
    assert.equal(again.statuses.a, 'done');
  });

  it('records how the run ended', () => {
    const state = applyEnd(initialRunState(), { status: 'error', error: 'The run failed unexpectedly.' });
    assert.deepEqual(state.ended, { status: 'error', error: 'The run failed unexpectedly.' });
  });

  it('treats missing and unknown statuses as pending', () => {
    assert.equal(statusOf({ a: 'done' }, 'b'), 'pending');
    assert.equal(statusOf({ a: 'exploded' }, 'a'), 'pending');
    assert.equal(statusOf({ a: 'skipped' }, 'a'), 'skipped');
  });
});
