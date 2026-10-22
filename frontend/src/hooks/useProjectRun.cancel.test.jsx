// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProject } from '../data/projects.js';
import { loadRunId } from '../lib/storage.js';
import { FakeEventSource } from '../../test/fakeEventSource.js';
import { useProjectRun } from './useProjectRun.js';

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startRun: vi.fn(),
  uploadFile: vi.fn(),
  cancelRun: vi.fn(),
  getResult: vi.fn(),
  getReview: vi.fn(),
  submitDecision: vi.fn(),
}));
const api = await import('../lib/api.js');

const project = getProject('approval-report-flow');
const inputs = { topic: 'Vertical farming', audience: 'City planners' };
const cancelled = { kind: 'final', body: { status: 'cancelled', error: null, result: null, files: [] } };

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  sessionStorage.clear();
  vi.clearAllMocks();
  api.cancelRun.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe('useProjectRun: cancelling', () => {
  it('cancels a run in progress and reports it', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    api.getResult.mockResolvedValue(cancelled);
    const { result } = renderHook(() => useProjectRun(project));
    await act(() => result.current.submit(inputs));
    expect(result.current.canCancel).toBe(true);
    await act(() => result.current.cancel());
    expect(api.cancelRun).toHaveBeenCalledWith('run-1');
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.notice).toEqual({ kind: 'cancelled', message: 'The run was cancelled.' });
    expect(result.current.canCancel).toBe(false);
    expect(result.current.cancelling).toBe(false);
  });

  it('cancels a run that waits for a decision and removes the draft', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    api.getReview.mockResolvedValue({ kind: 'ok', review: { draft: '# D', round: 1, revisionsUsed: 0, revisionsLeft: 3, maxRevisions: 3 } });
    api.getResult.mockResolvedValue(cancelled);
    const { result } = renderHook(() => useProjectRun(project));
    await act(() => result.current.submit(inputs));
    act(() => FakeEventSource.instances.at(-1).node(1, 'review_draft', 'waiting'));
    await waitFor(() => expect(result.current.phase).toBe('waiting'));
    expect(result.current.canCancel).toBe(true);
    await act(() => result.current.cancel());
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.review).toBeNull();
    expect(result.current.active).toBe(false);
  });

  it('offers no cancellation when nothing is running', () => {
    const { result } = renderHook(() => useProjectRun(project));
    expect(result.current.canCancel).toBe(false);
  });

  it('reports a connection problem when the server cannot be reached', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    api.getResult.mockResolvedValue({ kind: 'unreachable' });
    const { result } = renderHook(() => useProjectRun(project));
    await act(() => result.current.submit(inputs));
    await act(() => result.current.cancel());
    expect(result.current.notice.kind).toBe('connection');
    expect(result.current.cancelling).toBe(false);
  });

  it('stops uploading files and releases the run', async () => {
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    const withFiles = { ...project, inputs: [{ key: 'notes', label: 'Notes', type: 'file', required: false, extensions: ['.txt'], maxFiles: 2 }] };
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: { notes: 2 } });
    let release;
    api.uploadFile.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useProjectRun(withFiles));
    act(() => {
      result.current.submit({ notes: files });
    });
    await waitFor(() => expect(result.current.phase).toBe('uploading'));
    await act(() => result.current.cancel());
    await act(async () => release({}));
    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(api.uploadFile).toHaveBeenCalledTimes(1); // the second file was never sent
    expect(api.cancelRun).toHaveBeenCalledWith('run-1');
    expect(result.current.notice.kind).toBe('cancelled');
    expect(loadRunId(withFiles.id)).toBeNull();
  });
});
