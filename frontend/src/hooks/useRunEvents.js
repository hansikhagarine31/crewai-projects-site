import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/apiBase.js';
import { applyEnd, applyEvent, initialRunState } from '../lib/runState.js';

// The browser reconnects an EventSource by itself (and sends Last-Event-ID). This many
// consecutive failures without a successful connection are tolerated before giving up.
const MAX_FAILURES = 5;

// The server sends a heartbeat event every few seconds and announces the interval. If nothing at
// all arrives for three intervals the connection is treated as dead (a proxy or network can leave
// it open without delivering anything, and the browser then reports no error).
const DEFAULT_STALE_MS = 45 * 1000;
const MIN_STALE_MS = 6 * 1000;

/**
 * Subscribes to /api/runs/:runId/events and folds the events into a statuses map.
 *
 * connection: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed'
 *   closed = the run ended normally; failed = the stream could not be (re)established.
 *
 * @param {string | null} runId
 */
export function useRunEvents(runId) {
  // State is tagged with the run it belongs to, so that a render in which runId has just
  // changed can never show events or an end marker from the previous run.
  const [stored, setStored] = useState(() => ({ ...initialRunState(), forRun: null }));
  const [connection, setConnection] = useState('idle');
  const [attempt, setAttempt] = useState(0);
  const lastSeq = useRef(0);

  useEffect(() => {
    lastSeq.current = 0;
    setAttempt(0);
  }, [runId]);

  useEffect(() => {
    if (!runId || typeof EventSource === 'undefined') {
      setConnection('idle');
      return undefined;
    }

    // After a manual retry the browser has no Last-Event-ID to send, so pass it in the query.
    const forThisRun = (current) => (current.forRun === runId ? current : { ...initialRunState(), forRun: runId });
    const query = lastSeq.current > 0 ? `?lastEventId=${lastSeq.current}` : '';
    const source = new EventSource(apiUrl(`/api/runs/${encodeURIComponent(runId)}/events${query}`));
    let failures = 0;
    let finished = false;
    let lastMessage = Date.now();
    let staleAfter = DEFAULT_STALE_MS;
    const touch = () => {
      lastMessage = Date.now();
    };
    setConnection('connecting');

    const watchdog = setInterval(() => {
      if (finished || Date.now() - lastMessage <= staleAfter) return;
      finished = true;
      source.close();
      setConnection('failed');
    }, 1000);

    source.onopen = () => {
      failures = 0;
      touch();
      setConnection('open');
    };

    source.addEventListener('heartbeat', (message) => {
      touch();
      try {
        const { intervalMs } = JSON.parse(message.data);
        if (Number.isFinite(intervalMs) && intervalMs > 0) staleAfter = Math.max(intervalMs * 3, MIN_STALE_MS);
      } catch {
        // Keep the default.
      }
    });

    source.addEventListener('node', (message) => {
      touch();
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      const seq = Number(message.lastEventId);
      if (Number.isFinite(seq) && seq > lastSeq.current) lastSeq.current = seq;
      setStored((current) => applyEvent(forThisRun(current), seq, event));
    });

    source.addEventListener('end', (message) => {
      finished = true;
      clearInterval(watchdog);
      source.close();
      let end = { status: 'done', error: null };
      try {
        end = JSON.parse(message.data);
      } catch {
        // An end marker that cannot be read is treated as a normal end.
      }
      setStored((current) => applyEnd(forThisRun(current), end));
      setConnection('closed');
    });

    source.onerror = () => {
      if (finished) return;
      touch(); // the browser is already handling this failure; give its retry time to succeed
      // CLOSED means the server answered with an error (for example 404 for an expired run),
      // which the browser does not retry.
      if (source.readyState === EventSource.CLOSED) {
        setConnection('failed');
        return;
      }
      failures += 1;
      if (failures >= MAX_FAILURES) {
        source.close();
        setConnection('failed');
      } else {
        setConnection('reconnecting');
      }
    };

    return () => {
      finished = true;
      clearInterval(watchdog);
      source.close();
    };
  }, [runId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const { forRun, ...state } = stored.forRun === runId ? stored : { ...initialRunState(), forRun: runId };
  return { ...state, connection: runId ? connection : 'idle', retry };
}
