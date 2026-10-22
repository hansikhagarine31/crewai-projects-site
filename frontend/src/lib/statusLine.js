/**
 * The line shown under the diagram while a run is in progress, built from the latest event.
 * @param {{
 *   project: import('../data/projects.js').Project,
 *   phase: string,
 *   upload: { done: number, total: number } | null,
 *   events: Array<{ event: { nodeId: string, message: string } }>,
 *   connection: string,
 *   hasResult: boolean,
 * }} state
 */
export function statusLine({ project, phase, upload, events, connection, hasResult }) {
  if (phase === 'starting') return 'Starting the run.';
  if (phase === 'uploading') return `Uploading file ${Math.min(upload?.done ?? 0, (upload?.total ?? 1) - 1) + 1} of ${upload?.total ?? 1}.`;
  if (phase === 'recovering') return 'Retrieving the previous run.';
  if (phase === 'running') {
    if (connection === 'reconnecting') return 'The connection was interrupted. Reconnecting.';
    const latest = events.at(-1)?.event;
    if (!latest) return 'Waiting for the first update.';
    const label = project.nodes.find((node) => node.id === latest.nodeId)?.label ?? latest.nodeId;
    return latest.message ? `${label}: ${latest.message}` : label;
  }
  if (phase === 'waiting') return 'Waiting for your decision on the draft.';
  if (phase === 'finished' && hasResult) return 'The run has finished.';
  return '';
}

/** Short announcements for screen readers, changing only when the phase changes. */
export function phaseAnnouncement({ phase, hasResult }) {
  if (phase === 'running') return 'The run is in progress.';
  if (phase === 'waiting') return 'The draft is ready for review.';
  if (phase === 'finished') return hasResult ? 'The run has finished. The result is shown below.' : 'The run has ended without a result.';
  return '';
}
