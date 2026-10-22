import 'dotenv/config';

/** The first of several variable names that is set and not empty. */
const firstOf = (env, names) => names.map((name) => env[name]).find((value) => value !== undefined && value !== '');

/**
 * Origins that may call the API, from a comma-separated list. A trailing slash is removed, because a browser never
 * sends one in the Origin header and an entry with one would match nothing.
 */
export function parseOrigins(value) {
  const origins = String(value)
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return origins.length === 1 ? origins[0] : origins;
}

/** Reads the configuration from an environment. ALLOWED_ORIGIN, AGENT_BASE_URL and RATE_LIMIT are the documented names. */
export function loadConfig(env = process.env) {
  const num = (names, fallback) => {
    const raw = firstOf(env, [].concat(names));
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    port: num('PORT', 8000),
    corsOrigin: parseOrigins(firstOf(env, ['ALLOWED_ORIGIN', 'CORS_ORIGIN']) ?? 'http://localhost:5173'),
    trustProxy: env.TRUST_PROXY ?? false,
    agentsUrl: (firstOf(env, ['AGENT_BASE_URL', 'AGENTS_URL']) ?? 'http://127.0.0.1:8001').replace(/\/+$/, ''),
    agentSecret: env.AGENT_SHARED_SECRET ?? '',
    jsonLimit: env.JSON_LIMIT ?? '100kb',

    // Runs that one address may start per window.
    rateLimitRuns: num(['RATE_LIMIT', 'RATE_LIMIT_RUNS'], 5),
    rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
    maxConcurrentRuns: num('MAX_CONCURRENT_RUNS', 3),

    agentTimeoutMs: num('AGENT_TIMEOUT_MS', 15 * 60 * 1000),
    runTtlMs: num('RUN_TTL_MS', 30 * 60 * 1000),
    awaitingUploadTtlMs: num('AWAITING_UPLOAD_TTL_MS', 10 * 60 * 1000),
    // How long a run may wait for a person's decision. The agents service deletes the stored draft after the same time.
    waitingTtlMs: num('WAITING_TTL_MS', 30 * 60 * 1000),
    maxEventsPerRun: num('MAX_EVENTS_PER_RUN', 500),
    maxOutputBytes: num('MAX_OUTPUT_BYTES', 5 * 1024 * 1024),

    uploadMaxBytes: num('UPLOAD_MAX_BYTES', 2 * 1024 * 1024),

    cacheTtlMs: num('CACHE_TTL_MS', 60 * 60 * 1000),
    cacheMaxEntries: num('CACHE_MAX_ENTRIES', 100),
    cacheReplayDelayMs: num('CACHE_REPLAY_DELAY_MS', 150),

    sseHeartbeatMs: num('SSE_HEARTBEAT_MS', 15 * 1000),
  };
}

export const config = loadConfig();

/** Problems that make a deployment unsafe or unusable, as sentences. Empty when the configuration is sound. */
export function configProblems(config) {
  const problems = [];
  if (!config.agentSecret) problems.push('AGENT_SHARED_SECRET is not set, so the agents service would refuse every request.');
  if ([].concat(config.corsOrigin).includes('*')) problems.push('ALLOWED_ORIGIN must name the site; "*" would allow every origin.');
  if (!/^https?:\/\//.test(config.agentsUrl)) problems.push('AGENT_BASE_URL must begin with http:// or https://.');
  return problems;
}
