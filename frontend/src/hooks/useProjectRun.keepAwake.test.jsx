// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProject } from '../data/projects.js';
import { FakeEventSource } from '../../test/fakeEventSource.js';
import { KEEP_AWAKE_MS, useProjectRun } from './useProjectRun.js';

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startRun: vi.fn(),
  uploadFile: vi.fn(),
  cancelRun: vi.fn(),
  getResult: vi.fn(),
  getReview: vi.fn(),
  getHealth: vi.fn(),
}));
const api = await import('../lib/api.js');

const project = getProject('approval-report-flow');
const review = { draft: '# D', round: 1, revisionsUsed: 0, revisionsLeft: 3, maxRevisions: 3 };

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  sessionStorage.clear();
  vi.clearAllMocks();
  api.getHealth.mockResolvedValue({ ok: true, status: 200, body: {} });
  api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
  api.getReview.mockResolvedValue({ kind: 'ok', review });
  api.cancelRun.mockResolvedValue(undefined);
  api.getResult.mockResolvedValue({ kind: 'final', body: { status: 'cancelled', error: null, result: null, files: [] } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useProjectRun: keeping the services awake while a draft waits', () => {
  it('asks the server for its health at an interval shorter than 15 minutes, only while the draft waits, and stops afterwards', async () => {
    expect(KEEP_AWAKE_MS).toBeLessThan(15 * 60 * 1000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useProjectRun(project));
    await act(() => result.current.submit({ topic: 'Vertical farming', audience: 'City planners' }));
    // Running, not yet waiting: no requests.
    await act(() => vi.advanceTimersByTimeAsync(KEEP_AWAKE_MS * 2));
    expect(api.getHealth).not.toHaveBeenCalled();

    act(() => FakeEventSource.instances.at(-1).node(1, 'review_draft', 'waiting'));
    await waitFor(() => expect(result.current.phase).toBe('waiting'));
    await act(() => vi.advanceTimersByTimeAsync(KEEP_AWAKE_MS * 3));
    expect(api.getHealth).toHaveBeenCalledTimes(3);

    await act(() => result.current.cancel());
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    api.getHealth.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(KEEP_AWAKE_MS * 2));
    expect(api.getHealth).not.toHaveBeenCalled();
  });
});
