// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../../test/fakeEventSource.js';
import { useRunEvents } from './useRunEvents.js';

const latest = () => FakeEventSource.instances.at(-1);

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms) => act(() => vi.advanceTimersByTime(ms));

describe('useRunEvents', () => {
  it('stays idle without a run', () => {
    const { result } = renderHook(() => useRunEvents(null));
    expect(result.current.connection).toBe('idle');
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('opens the stream for the run and folds events into statuses', () => {
    const { result } = renderHook(() => useRunEvents('r1'));
    expect(latest().url).toBe('/api/runs/r1/events');
    act(() => latest().open());
    expect(result.current.connection).toBe('open');
    act(() => latest().node(1, 'a', 'running'));
    act(() => latest().node(2, 'a', 'done'));
    expect(result.current.statuses).toEqual({ a: 'done' });
  });

  it('ignores events that a reconnection replays', () => {
    const { result } = renderHook(() => useRunEvents('r1'));
    act(() => latest().node(1, 'a', 'running'));
    act(() => latest().node(1, 'a', 'running'));
    expect(result.current.events).toHaveLength(1);
  });

  it('reports a reconnection, then gives up after repeated failures', () => {
    const { result } = renderHook(() => useRunEvents('r1'));
    act(() => latest().open());
    act(() => latest().fail(FakeEventSource.CONNECTING));
    expect(result.current.connection).toBe('reconnecting');
    for (let i = 0; i < 4; i += 1) act(() => latest().fail(FakeEventSource.CONNECTING));
    expect(result.current.connection).toBe('failed');
    expect(latest().closed).toBe(true);
  });

  it('counts failures only since the last successful connection', () => {
    const { result } = renderHook(() => useRunEvents('r1'));
    for (let i = 0; i < 4; i += 1) act(() => latest().fail(FakeEventSource.CONNECTING));
    act(() => latest().open());
    for (let i = 0; i < 4; i += 1) act(() => latest().fail(FakeEventSource.CONNECTING));
    expect(result.current.connection).toBe('reconnecting');
  });

  it('fails at once when the server refuses the stream', () => {
    const { result } = renderHook(() => useRunEvents('gone'));
    act(() => latest().fail(FakeEventSource.CLOSED));
    expect(result.current.connection).toBe('failed');
  });

  it('closes when the run ends and records how it ended', () => {
    const { result } = renderHook(() => useRunEvents('r1'));
    act(() => latest().send('end', { status: 'error', error: 'Failed.' }));
    expect(result.current.ended).toEqual({ status: 'error', error: 'Failed.' });
    expect(result.current.connection).toBe('closed');
    expect(latest().closed).toBe(true);
  });

  it('shows nothing from a previous run when the run changes', () => {
    const { result, rerender } = renderHook(({ id }) => useRunEvents(id), { initialProps: { id: 'r1' } });
    act(() => latest().node(1, 'a', 'done'));
    act(() => latest().send('end', { status: 'done', error: null }));
    rerender({ id: 'r2' });
    expect(result.current.statuses).toEqual({});
    expect(result.current.ended).toBeNull();
  });

  it('resumes from the last event after a manual retry', () => {
    const { result } = renderHook(() => useRunEvents('r1'));
    act(() => latest().node(7, 'a', 'running'));
    act(() => latest().fail(FakeEventSource.CLOSED));
    act(() => result.current.retry());
    expect(latest().url).toBe('/api/runs/r1/events?lastEventId=7');
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  describe('a connection that goes silent', () => {
    it('is treated as lost when nothing arrives for 45 seconds, since the browser reports no error', () => {
      const { result } = renderHook(() => useRunEvents('r1'));
      act(() => latest().open());
      advance(44 * 1000);
      expect(result.current.connection).toBe('open');
      advance(2 * 1000);
      expect(result.current.connection).toBe('failed');
      expect(latest().closed).toBe(true);
    });

    it('stays open while heartbeats keep arriving, even if the run is quiet', () => {
      const { result } = renderHook(() => useRunEvents('r1'));
      act(() => latest().open());
      for (let i = 0; i < 10; i += 1) {
        advance(15 * 1000);
        act(() => latest().heartbeat(15000));
      }
      expect(result.current.connection).toBe('open');
    });

    it('uses the interval announced by the server', () => {
      const { result } = renderHook(() => useRunEvents('r1'));
      act(() => latest().open());
      act(() => latest().heartbeat(2000)); // three intervals, but never less than six seconds
      advance(5 * 1000);
      expect(result.current.connection).toBe('open');
      advance(2 * 1000);
      expect(result.current.connection).toBe('failed');
    });

    it('stops watching once the run has ended', () => {
      const { result } = renderHook(() => useRunEvents('r1'));
      act(() => latest().send('end', { status: 'done', error: null }));
      advance(120 * 1000);
      expect(result.current.connection).toBe('closed');
    });
  });
});
