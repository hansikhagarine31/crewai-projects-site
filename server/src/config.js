import 'dotenv/config';

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const config = {
  port: num('PORT', 8000),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  trustProxy: process.env.TRUST_PROXY ?? false,
  agentsUrl: process.env.AGENTS_URL ?? 'http://127.0.0.1:8001',
  agentSecret: process.env.AGENT_SHARED_SECRET ?? '',
  jsonLimit: process.env.JSON_LIMIT ?? '100kb',

  rateLimitRuns: num('RATE_LIMIT_RUNS', 5),
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  maxConcurrentRuns: num('MAX_CONCURRENT_RUNS', 3),

  agentTimeoutMs: num('AGENT_TIMEOUT_MS', 5 * 60 * 1000),
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
