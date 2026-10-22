/** Compares sets of node ids from the three sources and describes every difference. */
export function compareNodeIds(projectId, sources) {
  const names = Object.keys(sources);
  const problems = [];
  const union = new Set(names.flatMap((name) => [...sources[name]]));
  for (const id of [...union].sort()) {
    const missingFrom = names.filter((name) => !sources[name].has(id));
    if (missingFrom.length) {
      const present = names.filter((name) => sources[name].has(id));
      problems.push(`${projectId}: node id "${id}" is in ${present.join(', ')} but missing from ${missingFrom.join(', ')}`);
    }
  }
  return problems;
}
