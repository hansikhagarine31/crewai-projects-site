// The last run of each project is kept in sessionStorage so that a refresh can recover its result.
// Storage can be unavailable (private windows, blocked site data), so every call is guarded.

const key = (projectId) => `crewai-projects:last-run:${projectId}`;

export function loadRunId(projectId) {
  try {
    return sessionStorage.getItem(key(projectId));
  } catch {
    return null;
  }
}

export function saveRunId(projectId, runId) {
  try {
    sessionStorage.setItem(key(projectId), runId);
  } catch {
    // Not persisted; the page still works.
  }
}

export function clearRunId(projectId) {
  try {
    sessionStorage.removeItem(key(projectId));
  } catch {
    // Nothing to clear.
  }
}
