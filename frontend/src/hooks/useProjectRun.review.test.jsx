// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProject } from '../data/projects.js';
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
  getReview: vi.fn(),
  submitDecision: vi.fn(),
}));
const api = await import('../lib/api.js');

const project = getProject('approval-report-flow');
const latest = () => FakeEventSource.instances.at(-1);
const review = (round = 1, extra = {}) => ({
  draft: `# Draft ${round}`,
  round,
  revisionsUsed: round - 1,
  revisionsLeft: 4 - round,
  maxRevisions: 3,
  notes: [],
  expiresAt: Date.now() + 30 * 60 * 1000,
  ...extra,
});
const final = (markdown = '# Final') => ({ kind: 'final', body: { runId: 'run-1', status: 'done', cached: false, error: null, result: { markdown }, files: [] } });

async function startAndWait() {
  api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
  api.getReview.mockResolvedValue({ kind: 'ok', review: review(1) });
  const hook = renderHook(() => useProjectRun(project));
  await act(() => hook.result.current.submit({ topic: 'Vertical farming', audience: 'City planners' }));
  act(() => latest().node(1, 'writing_crew', 'done'));
  act(() => latest().node(2, 'review_draft', 'waiting', 'Waiting for your decision on draft 1'));
  await waitFor(() => expect(hook.result.current.phase).toBe('waiting'));
  return hook;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  sessionStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

describe('useProjectRun: a run that waits for a decision', () => {
  it('fetches the draft when review_draft is waiting, and stays attached to the stream', async () => {
    const { result } = await startAndWait();
    expect(api.getReview).toHaveBeenCalledWith('run-1');
    expect(result.current.review.draft).toBe('# Draft 1');
    expect(result.current.active).toBe(true); // the Run button stays disabled
    expect(latest().closed).toBe(false);
    expect(result.current.statuses.review_draft).toBe('waiting');
  });

  it('does not fetch the draft twice for the same waiting event', async () => {
    const { result } = await startAndWait();
    act(() => latest().node(3, 'collect_topic', 'done')); // an unrelated event changes the list
    await act(async () => {});
    expect(api.getReview).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('waiting');
  });

  it('sends the decision, returns to running, and fetches the next draft in the next round', async () => {
    api.submitDecision.mockResolvedValue({});
    const { result } = await startAndWait();

    await act(() => result.current.decide('revise', 'Please shorten the introduction.'));
    expect(api.submitDecision).toHaveBeenCalledWith('run-1', 'revise', 'Please shorten the introduction.');
    expect(result.current.phase).toBe('running');
    expect(result.current.review).toBeNull();
    expect(api.getReview).toHaveBeenCalledTimes(1); // the old waiting event is not fetched again

    api.getReview.mockResolvedValue({ kind: 'ok', review: review(2) });
    act(() => latest().node(4, 'review_draft', 'done'));
    act(() => latest().node(5, 'revision_crew', 'done'));
    act(() => latest().node(6, 'review_draft', 'waiting'));
    await waitFor(() => expect(result.current.phase).toBe('waiting'));
    expect(result.current.review.round).toBe(2);
    expect(api.getReview).toHaveBeenCalledTimes(2);
  });

  it('shows the final result after an approval', async () => {
    api.submitDecision.mockResolvedValue({});
    api.getResult.mockResolvedValue(final());
    const { result } = await startAndWait();
    await act(() => result.current.decide('approved', ''));
    act(() => latest().node(3, 'review_draft', 'done'));
    act(() => latest().node(4, 'publish_report', 'done'));
    act(() => latest().send('end', { status: 'done', error: null }));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.result.result.markdown).toBe('# Final');
    expect(result.current.active).toBe(false);
  });

  it('sends only one decision while another is being sent', async () => {
    let finish;
    api.submitDecision.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result } = await startAndWait();
    act(() => {
      result.current.decide('approved', '');
    });
    await waitFor(() => expect(result.current.deciding).toBe(true));
    await act(() => result.current.decide('revise', 'Change it.'));
    expect(api.submitDecision).toHaveBeenCalledTimes(1);
    await act(async () => finish({}));
  });

  it('keeps the draft waiting and explains a refusal for lack of capacity', async () => {
    api.submitDecision.mockRejectedValue(new ApiError(503, 'busy'));
    const { result } = await startAndWait();
    await act(() => result.current.decide('approved', ''));
    expect(result.current.phase).toBe('waiting');
    expect(result.current.notice.kind).toBe('capacity');
    expect(result.current.notice.message).toMatch(/still waiting/);
    expect(result.current.deciding).toBe(false);
  });

  it('keeps the draft waiting when the server cannot be reached', async () => {
    api.submitDecision.mockRejectedValue(new ApiError(0, ''));
    const { result } = await startAndWait();
    await act(() => result.current.decide('approved', ''));
    expect(result.current.phase).toBe('waiting');
    expect(result.current.notice.kind).toBe('connection');
  });

  it('looks at the run again when the decision finds that it has moved on', async () => {
    api.submitDecision.mockRejectedValue(new ApiError(409, 'not waiting'));
    api.getResult.mockResolvedValue({ kind: 'final', body: { status: 'expired', error: 'The report was not reviewed within 30 minutes.', result: null, files: [] } });
    const { result } = await startAndWait();
    await act(() => result.current.decide('approved', ''));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.notice).toEqual({ kind: 'expired', message: 'The report was not reviewed within 30 minutes.' });
  });

  it('reports a run that expired while it waited', async () => {
    const { result } = await startAndWait();
    act(() => latest().send('end', { status: 'expired', error: 'The report was not reviewed within 30 minutes, so the run has ended and the draft has been deleted.' }));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.review).toBeNull();
    expect(result.current.notice.kind).toBe('expired');
    expect(result.current.notice.message).toMatch(/not reviewed within 30 minutes/);
    expect(result.current.active).toBe(false);
  });

  it('returns to running when another tab has already decided', async () => {
    const { result } = await startAndWait();
    act(() => latest().node(3, 'review_draft', 'done'));
    await waitFor(() => expect(result.current.phase).toBe('running'));
    expect(result.current.review).toBeNull();
  });

  it('goes on quietly when the run has already moved on by the time the draft is requested', async () => {
    api.startRun.mockResolvedValue({ runId: 'run-1', awaitingFiles: {} });
    api.getReview.mockResolvedValue({ kind: 'not-waiting' });
    const { result } = renderHook(() => useProjectRun(project));
    await act(() => result.current.submit({ topic: 'Vertical farming', audience: 'City planners' }));
    act(() => latest().node(1, 'review_draft', 'waiting'));
    await act(async () => {});
    expect(result.current.phase).toBe('running');
    expect(result.current.notice).toBeNull();
  });

  it('clears the draft when a new run is started', async () => {
    api.submitDecision.mockResolvedValue({});
    const { result } = await startAndWait();
    api.startRun.mockResolvedValue({ runId: 'run-2', awaitingFiles: {} });
    act(() => latest().send('end', { status: 'cancelled', error: null }));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    await act(() => result.current.submit({ topic: 'Another topic', audience: 'Readers' }));
    expect(result.current.review).toBeNull();
    expect(loadRunId('approval-report-flow')).toBe('run-2');
  });
});

describe('useProjectRun: a waiting run after a refresh', () => {
  it('shows the draft again and keeps following the run', async () => {
    sessionStorage.setItem('crewai-projects:last-run:approval-report-flow', 'run-1');
    api.getResult.mockResolvedValue({ kind: 'pending', status: 'waiting', review: review(2) });
    const { result } = renderHook(() => useProjectRun(project));
    await waitFor(() => expect(result.current.phase).toBe('waiting'));
    expect(result.current.review.round).toBe(2);
    expect(result.current.active).toBe(true);
    expect(latest().url).toContain('/api/runs/run-1/events');
    // The replayed history ends with the waiting event, so the draft is not fetched again and the panel stays.
    act(() => latest().node(1, 'review_draft', 'waiting'));
    await act(async () => {});
    expect(result.current.phase).toBe('waiting');
  });

  it('shows how an expired run ended', async () => {
    sessionStorage.setItem('crewai-projects:last-run:approval-report-flow', 'run-1');
    api.getResult.mockResolvedValue({ kind: 'final', body: { status: 'expired', error: null, result: null, files: [] } });
    const { result } = renderHook(() => useProjectRun(project));
    await waitFor(() => expect(result.current.phase).toBe('finished'));
    expect(result.current.notice.kind).toBe('expired');
    expect(result.current.notice.message).toMatch(/not reviewed within 30 minutes/);
  });
});
