import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { projects } from '../src/data/projects.js';
import { columnsOf, describeSequence } from '../src/lib/layout.js';

const root = new URL('../../', import.meta.url);
const shared = JSON.parse(readFileSync(new URL('shared/projects.json', root), 'utf8'));
const reference = readFileSync(new URL('design/reference.html', root), 'utf8');
const sections = reference.split('<section class="proj" id="').slice(1);

const VARIANTS = new Set(['input', 'step', 'crew', 'router', 'join', 'dashed', 'output']);

describe('project data against shared/projects.json', () => {
  it('has the ten public projects, in order, with the shared ids', () => {
    const expected = shared.projects.filter((project) => !project.internal).map((project) => project.id);
    assert.deepEqual(projects.map((project) => project.id), expected);
    assert.deepEqual(projects.map((project) => project.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  for (const project of projects) {
    describe(project.id, () => {
      const definition = shared.projects.find((entry) => entry.id === project.id);

      it('uses exactly the node ids, titles and input fields of the shared file', () => {
        assert.deepEqual(project.nodes.map((node) => node.id).sort(), definition.nodes.map((node) => node.nodeId).sort());
        assert.equal(project.title, definition.title);
        assert.deepEqual(project.inputs, definition.inputs);
        assert.deepEqual(project.requireAnyOf, definition.requireAnyOf);
      });

      it('has valid variants, unique ids and edges between existing nodes', () => {
        const ids = new Set(project.nodes.map((node) => node.id));
        assert.equal(ids.size, project.nodes.length);
        for (const node of project.nodes) assert.ok(VARIANTS.has(node.variant), `${node.id}: ${node.variant}`);
        for (const edge of project.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to), `${edge.from} > ${edge.to}`);
      });

      it('connects only neighbouring columns, left to right', () => {
        const column = new Map(project.nodes.map((node) => [node.id, node.column]));
        for (const edge of project.edges) assert.equal(column.get(edge.to) - column.get(edge.from), 1, `${edge.from} > ${edge.to}`);
      });

      it('reaches every node from the first column', () => {
        const reached = new Set(project.nodes.filter((node) => node.column === 0).map((node) => node.id));
        for (let i = 0; i < project.nodes.length; i += 1) {
          for (const edge of project.edges) if (reached.has(edge.from)) reached.add(edge.to);
        }
        assert.equal(reached.size, project.nodes.length);
      });

      it('matches design/reference.html: copy, node count and accessible sequence', () => {
        const section = sections[project.number - 1];
        const text = (value) => value.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
        assert.ok(section.includes(`>${project.title}</h2>`));
        assert.ok(text(section).includes(`<p>${project.problem}</p>`));
        assert.ok(text(section).includes(`Free: ${project.freeTools}</p>`));
        assert.equal((section.match(/<g class="nd /g) ?? []).length, project.nodes.length);
        for (const node of project.nodes) {
          assert.ok(text(section).includes(`>${node.label}</text>`), node.label);
          if (node.tag) assert.ok(text(section).includes(`>${node.tag}</text>`), node.tag);
          if (node.sublabel) assert.ok(text(section).includes(`>${node.sublabel}</text>`), node.sublabel);
        }
        const aria = text(section.match(/aria-label="(Flow diagram:[^"]*)"/)[1]);
        assert.equal(`Flow diagram: ${describeSequence(project)}`, aria);
      });

      it('groups parallel nodes under their label', () => {
        for (const group of project.groups) {
          const members = columnsOf(project)[group.column].nodes.map((node) => node.id);
          assert.deepEqual(group.nodeIds, members);
        }
      });
    });
  }
});
