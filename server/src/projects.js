import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFINITION_FILE = fileURLToPath(new URL('../../shared/projects.json', import.meta.url));

export function loadProjects(file = DEFINITION_FILE) {
  const definition = JSON.parse(readFileSync(file, 'utf8'));
  const byId = new Map(definition.projects.map((project) => [project.id, project]));
  return {
    statuses: definition.statuses,
    list: () => definition.projects.filter((project) => !project.internal),
    get: (id) => byId.get(id),
  };
}

const defaultProjects = loadProjects();

export const STATUSES = defaultProjects.statuses;
export const listProjects = defaultProjects.list;

/** Returns the project definition, or undefined when the id is unknown. */
export const getProject = defaultProjects.get;

export function nodeIdsOf(project) {
  return new Set(project.nodes.map((node) => node.nodeId));
}
