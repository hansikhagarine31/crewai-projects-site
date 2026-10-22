import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBase, apiUrl } from './apiBase.js';

afterEach(() => vi.unstubAllEnvs());

describe('apiUrl', () => {
  it('leaves a path as it is when no server address is set, so that the Vite proxy applies', () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(apiBase()).toBe('');
    expect(apiUrl('/api/health')).toBe('/api/health');
  });

  it('prefixes the server address', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://crewai-server.onrender.com');
    expect(apiUrl('/api/runs/1/events')).toBe('https://crewai-server.onrender.com/api/runs/1/events');
  });

  it('removes trailing slashes and spaces, which would otherwise produce a double slash', () => {
    vi.stubEnv('VITE_API_BASE_URL', ' https://crewai-server.onrender.com// ');
    expect(apiUrl('/api/health')).toBe('https://crewai-server.onrender.com/api/health');
  });
});
