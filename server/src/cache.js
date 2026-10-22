import { createHash } from 'node:crypto';

/** Collapses whitespace and sorts keys so equivalent inputs hash identically. */
function normalise(value) {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    if (value.content !== undefined && value.filename !== undefined) {
      // Uploaded file: identify by content, not by name.
      return { file: createHash('sha256').update(value.content).digest('hex') };
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalise(value[key])]),
    );
  }
  return value;
}

export function cacheKey(projectId, inputs) {
  const canonical = JSON.stringify({ projectId, inputs: normalise(inputs) });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Cache of finished runs, keyed by project and a hash of the inputs.
 * An entry holds the event sequence, the result and the output files.
 */
export function createCache({ ttlMs = 60 * 60 * 1000, maxEntries = 100, now = Date.now } = {}) {
  const entries = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (now() - entry.storedAt > ttlMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function set(key, value) {
    entries.delete(key);
    entries.set(key, { ...value, storedAt: now() });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  return { get, set, size: () => entries.size };
}
