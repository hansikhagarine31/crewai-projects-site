/**
 * The address of the server, from VITE_API_BASE_URL when the site and the server are on different hosts.
 * Empty means the same origin: in development Vite proxies /api to the local server.
 * The value is read at build time and is public, so it must never hold a secret.
 */
export function apiBase() {
  return String(import.meta.env?.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

/** Prefixes a path such as /api/health with the server address. */
export function apiUrl(path) {
  return `${apiBase()}${path}`;
}
