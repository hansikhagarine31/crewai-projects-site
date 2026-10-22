// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoProject } from '../data/projects.js';
import { ApiError } from '../lib/api.js';
import { loadRunId } from '../lib/storage.js';
import { FakeEventSource } from '../../test/fakeEventSource.js';
import { useProjectRun } from './useProjectRun.js';

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startRun: vi.fn(),
  uploadFile: vi.fn(),
  cancelRun: vi.fn(),
  getResult: vi.fn(),
}));
const api = await import('../lib/api.js');

const latest = () => FakeEventSource.instances.at(-1);
const done = (markdown = '# Done') => ({ kind: 'final', body: { runId: 'run-1', status: 'done', cached: false, error: null, result: { markdown }, files: [] } });

const fileProject = {
  ...demoProject,
  inputs: [...demoProject.inputs],
};

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  sessionStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

describe('useProjectRun: a run without files', () => {
  it('starts the run, follows the stream, and fetches the result when the stream ends', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    api.getResult.mockResolvedValue(done());
    const { result } = renderHook(() => useProjectRun(demoProject));

    await act(() => result.current.submit({ topic: 'Farming', notes: [] }));
    expect(api.startRun).toHaveBeenCalledWith('demo', { topic: 'Farming' }, undefined);
    expect(result.current.phase).toBe('running');
    expect(result.current.active).toBe(true);
    expect(loadRunId('demo')).toBe('run-1');
    expect(latest().url).toBe('/api/runs/run-1/events');

    act(() => latest().node(1, 'topic', 'running', 'Working on topic'));
    act(() => latest().node(2, 'topic', 'done'));
    expect(result.current.statuses).toEqual({ topic: 'done' });
    expect(result.current.events.at(-1).event.nodeId).toBe('topic');

    act(() => latest().send('end', { status: 'done', error: null }));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.active).toBe(false);
    expect(result.current.result.result.markdown).toBe('# Done');
    expect(result.current.notice).toBeNull();
  });

  it('opens no stream before the run has been created', async () => {
    let create;
    api.startRun.mockReturnValue(new Promise((resolve) => (create = resolve)));
    const { result } = renderHook(() => useProjectRun(demoProject));
    act(() => {
      result.current.submit({ topic: 'x', notes: [] });
    });
    await waitFor(() => expect(result.current.phase).toBe('starting'));
    expect(result.current.active).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(0);
    await act(async () => create({ runId: 'run-1', awaitingFiles: {} }));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('reports a failed run with its message and no result', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await act(() => result.current.submit({ topic: 'x', notes: [] }));
    act(() => latest().node(1, 'plan', 'error', 'The run failed unexpectedly.'));
    act(() => latest().send('end', { status: 'error', error: 'The run failed unexpectedly.' }));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.notice).toEqual({ kind: 'failed', message: 'The run failed unexpectedly.' });
    expect(result.current.result).toBeNull();
    expect(result.current.statuses.plan).toBe('error');
    expect(api.getResult).not.toHaveBeenCalled();
  });

  it('allows a new run after a failure and clears the previous statuses', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await act(() => result.current.submit({ topic: 'x', notes: [] }));
    act(() => latest().node(1, 'topic', 'done'));
    act(() => latest().send('end', { status: 'error', error: 'Failed.' }));
    await waitFor(() => expect(result.current.phase).toBe('finished'));

    api.startRun.mockResolvedValue({ runId: 'run-2', awaitingFiles: {} });
    await act(() => result.current.submit({ topic: 'y', notes: [] }));
    expect(result.current.statuses).toEqual({});
    expect(result.current.notice).toBeNull();
    expect(loadRunId('demo')).toBe('run-2');
  });
});

describe('useProjectRun: errors when starting', () => {
  it('states when the visitor may retry after a rate limit', async () => {
    api.startRun.mockRejectedValue(new ApiError(429, 'x', { retryAfter: 600 }));
    const { result } = renderHook(() => useProjectRun(demoProject));
    await act(() => result.current.submit({ topic: 'x', notes: [] }));
    expect(result.current.phase).toBe('idle');
    expect(result.current.active).toBe(false);
    expect(result.current.notice.kind).toBe('rate-limit');
    expect(result.current.notice.message).toMatch(/You may try again at \d\d:\d\d \(in about 10 minutes\)\./);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(loadRunId('demo')).toBeNull();
  });

  it('reports that the server cannot be reached', async () => {
    api.startRun.mockRejectedValue(new ApiError(0, 'The server could not be reached.'));
    const { result } = renderHook(() => useProjectRun(demoProject));
    await act(() => result.current.submit({ topic: 'x', notes: [] }));
    expect(result.current.notice.kind).toBe('connection');
  });
});

describe('useProjectRun: a run with files', () => {
  const upload = (name) => new File(['x'], name, { type: 'text/plain' });

  it('declares the files, uploads them, and only then opens the stream', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: { notes: 2 } });
    const finishUploads = [];
    api.uploadFile.mockImplementation(() => new Promise((resolve) => finishUploads.push(resolve)));
    const { result } = renderHook(() => useProjectRun(fileProject));

    const files = [upload('a.txt'), upload('b.txt')];
    act(() => {
      result.current.submit({ topic: 'x', notes: files });
    });
    await waitFor(() => expect(result.current.phase).toBe('uploading'));
    expect(api.startRun).toHaveBeenCalledWith('demo', { topic: 'x' }, { notes: 2 });

    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1));
    expect(api.uploadFile).toHaveBeenLastCalledWith('run-1', 'notes', files[0]);
    expect(result.current.upload).toEqual({ done: 0, total: 2 });
    expect(FakeEventSource.instances).toHaveLength(0);

    await act(async () => finishUploads[0]());
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2));
    expect(result.current.upload).toEqual({ done: 1, total: 2 });
    expect(FakeEventSource.instances).toHaveLength(0);

    await act(async () => finishUploads[1]());
    await waitFor(() => expect(result.current.phase).toBe('running'));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(result.current.upload).toBeNull();
  });

  it('releases the run and reports the server message when an upload is refused', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: { notes: 1 } });
    api.uploadFile.mockRejectedValue(new ApiError(415, 'The file content is not plain UTF-8 text.'));
    const { result } = renderHook(() => useProjectRun(fileProject));
    await act(() => result.current.submit({ topic: 'x', notes: [upload('a.txt')] }));
    expect(api.cancelRun).toHaveBeenCalledWith('run-1');
    expect(result.current.phase).toBe('idle');
    expect(result.current.notice).toEqual({ kind: 'invalid', message: 'The file content is not plain UTF-8 text.' });
    expect(loadRunId('demo')).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe('useProjectRun: connection lost', () => {
  it('offers to reload the result, and shows it when the run finished meanwhile', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await act(() => result.current.submit({ topic: 'x', notes: [] }));

    act(() => latest().fail(FakeEventSource.CLOSED)); // the server answered with an error
    await waitFor(() => expect(result.current.notice?.kind).toBe('connection'));

    api.getResult.mockResolvedValue(done('# Finished while away'));
    await act(() => result.current.reload());
    expect(result.current.phase).toBe('finished');
    expect(result.current.result.result.markdown).toBe('# Finished while away');
    expect(result.current.notice).toBeNull();
  });

  it('reconnects to a run that is still in progress', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await act(() => result.current.submit({ topic: 'x', notes: [] }));
    act(() => latest().node(1, 'topic', 'done'));
    act(() => latest().fail(FakeEventSource.CLOSED));
    await waitFor(() => expect(result.current.notice?.kind).toBe('connection'));

    api.getResult.mockResolvedValue({ kind: 'pending' });
    await act(() => result.current.reload());
    expect(result.current.notice).toBeNull();
    expect(result.current.phase).toBe('running');
    expect(latest().url).toBe('/api/runs/run-1/events?lastEventId=1');
  });

  it('keeps the offer when the server is still unreachable', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await act(() => result.current.submit({ topic: 'x', notes: [] }));
    act(() => latest().fail(FakeEventSource.CLOSED));
    api.getResult.mockResolvedValue({ kind: 'unreachable' });
    await act(() => result.current.reload());
    expect(result.current.notice.kind).toBe('connection');
  });
});

describe('useProjectRun: recovery after a refresh', () => {
  it('shows the stored result of the last run', async () => {
    sessionStorage.setItem('crewai-projects:last-run:demo', 'run-1');
    api.getResult.mockResolvedValue(done('# Recovered'));
    const { result } = renderHook(() => useProjectRun(demoProject));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(api.getResult).toHaveBeenCalledWith('run-1');
    expect(result.current.result.result.markdown).toBe('# Recovered');
    // The stream is attached so that the diagram shows the final statuses.
    expect(latest().url).toBe('/api/runs/run-1/events');
    act(() => latest().node(1, 'topic', 'done'));
    expect(result.current.statuses.topic).toBe('done');
  });

  it('keeps following a run that is still in progress', async () => {
    sessionStorage.setItem('crewai-projects:last-run:demo', 'run-1');
    api.getResult.mockResolvedValue({ kind: 'pending' });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await waitFor(() => expect(result.current.phase).toBe('running'));
    expect(result.current.active).toBe(true);
  });

  it('forgets a run the server no longer holds, and says so', async () => {
    sessionStorage.setItem('crewai-projects:last-run:demo', 'gone');
    api.getResult.mockResolvedValue({ kind: 'missing' });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await waitFor(() => expect(result.current.notice?.kind).toBe('expired'));
    expect(result.current.phase).toBe('idle');
    expect(loadRunId('demo')).toBeNull();
  });

  it('reports a failed earlier run without a stack trace', async () => {
    sessionStorage.setItem('crewai-projects:last-run:demo', 'run-1');
    api.getResult.mockResolvedValue({ kind: 'final', body: { status: 'error', error: 'The run failed unexpectedly.', result: null, files: [] } });
    const { result } = renderHook(() => useProjectRun(demoProject));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.notice).toEqual({ kind: 'failed', message: 'The run failed unexpectedly.' });
  });

  it('does nothing when no run is stored', () => {
    renderHook(() => useProjectRun(demoProject));
    expect(api.getResult).not.toHaveBeenCalled();
  });

  it('keeps the last run of each project separate', async () => {
    sessionStorage.setItem('crewai-projects:last-run:blog-post-crew', 'other');
    renderHook(() => useProjectRun(demoProject));
    expect(api.getResult).not.toHaveBeenCalled();
  });
});
