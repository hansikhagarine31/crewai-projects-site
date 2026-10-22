import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, cancelRun, getHealth, getResult, getReview, startRun, submitDecision, uploadFile } from '../lib/api.js';
import { buildRequest } from '../lib/validateInputs.js';
import {
  cancelledNotice,
  connectionLostNotice,
  decisionNotice,
  expiredNotice,
  failedRunNotice,
  noticeFromApiError,
  reviewExpiredNotice,
} from '../lib/notices.js';
import { clearRunId, loadRunId, saveRunId } from '../lib/storage.js';
import { useRunEvents } from './useRunEvents.js';

// Free hosts stop a service that receives no request for 15 minutes, which would delete a draft that waits for a decision.
// While a draft waits, the page therefore makes a small request to the server (which asks the agents service) at this interval.
export const KEEP_AWAKE_MS = 4 * 60 * 1000;

const endNotice = (status, error) =>
  status === 'cancelled' ? cancelledNotice() : status === 'expired' ? reviewExpiredNotice(error) : failedRunNotice(error);

/**
 * Everything about running one project: creating the run, uploading files, following the
 * event stream, fetching the result, and recovering the last run after a page refresh.
 *
 * phase: 'idle' | 'starting' | 'uploading' | 'running' | 'waiting' | 'recovering' | 'finished'
 *   waiting = the run is paused for a decision; `review` then holds the draft.
 *
 * @param {import('../data/projects.js').Project} project
 */
export function useProjectRun(project) {
  const [runId, setRunId] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState(null);
  const [upload, setUpload] = useState(null); // { done, total } while files are uploading
  const [review, setReview] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false); // set while files are uploading, when there is no running run yet
  const reviewedSeq = useRef(0); // the waiting event whose draft has been fetched
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The stream is opened only once the run has everything it needs, and stays attached after
  // the run finishes so that the diagram keeps its final statuses (the server replays history).
  const streamId = phase === 'running' || phase === 'waiting' || phase === 'finished' || phase === 'recovering' ? runId : null;
  const stream = useRunEvents(streamId);

  /** Applies the server's answer about a run: used after a refresh and by "Reload result". */
  const inspect = useCallback(
    async (id) => {
      const answer = await getResult(id);
      if (!alive.current) return;
      if (answer.kind === 'unreachable') {
        setPhase('recovering');
        setNotice(connectionLostNotice());
      } else if (answer.kind === 'missing') {
        clearRunId(project.id);
        setRunId(null);
        setPhase('idle');
        setNotice(expiredNotice());
      } else if (answer.kind === 'pending' && answer.status === 'waiting' && answer.review) {
        setNotice(null);
        setReview(answer.review);
        setPhase('waiting');
        stream.retry();
      } else if (answer.kind === 'pending') {
        setNotice(null);
        setPhase('running');
        stream.retry();
      } else {
        setReview(null);
        setNotice(answer.body.status === 'done' ? null : endNotice(answer.body.status, answer.body.error));
        setResult(answer.body.status === 'done' ? answer.body : null);
        setPhase('finished');
      }
    },
    [project.id, stream.retry],
  );

  // Recover the last run of this project after a refresh.
  useEffect(() => {
    const id = loadRunId(project.id);
    if (!id) return;
    setRunId(id);
    setPhase('recovering');
    inspect(id);
  }, [project.id]);

  // The latest event of review_draft: the run is waiting when it is "waiting", and has moved on when it is "done".
  const reviewEvent = [...stream.events].reverse().find(({ event }) => event.nodeId === 'review_draft');
  const waitingSeq = reviewEvent?.event.status === 'waiting' ? reviewEvent.seq : 0;
  const reviewMovedOn = reviewEvent?.event.status === 'done';

  // The run reached a decision step: fetch the draft. Each waiting event is handled once, so that a draft
  // is fetched again only for the next round.
  useEffect(() => {
    if (phase !== 'running' || !waitingSeq || reviewedSeq.current === waitingSeq) return;
    reviewedSeq.current = waitingSeq;
    getReview(runId).then((answer) => {
      if (!alive.current) return;
      if (answer.kind === 'ok') {
        setReview(answer.review);
        setPhase('waiting');
      } else if (answer.kind === 'unreachable') {
        setNotice(connectionLostNotice());
      }
      // 'not-waiting' means the run has already moved on; the stream will say so.
    });
  }, [phase, waitingSeq, runId]);

  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    const timer = setInterval(() => {
      getHealth();
    }, KEEP_AWAKE_MS);
    return () => clearInterval(timer);
  }, [phase]);

  // Another tab decided, so the draft is no longer waiting here.
  useEffect(() => {
    if (phase === 'waiting' && reviewMovedOn) {
      setReview(null);
      setPhase('running');
    }
  }, [phase, reviewMovedOn]);

  // The stream ended: fetch the result, or report how the run ended.
  useEffect(() => {
    if ((phase !== 'running' && phase !== 'waiting') || !stream.ended) return;
    const { status, error } = stream.ended;
    if (status === 'done') {
      inspect(runId);
    } else {
      setReview(null);
      setNotice(endNotice(status, error));
      setPhase('finished');
    }
  }, [phase, stream.ended, runId, inspect]);

  // The stream could not be kept open: offer to reload the result.
  useEffect(() => {
    if (phase === 'running' && stream.connection === 'failed' && !stream.ended) setNotice(connectionLostNotice());
  }, [phase, stream.connection, stream.ended]);

  /** Runs the project with validated form values. */
  const submit = useCallback(
    async (values) => {
      const { inputs, counts, files } = buildRequest(project, values);
      setNotice(null);
      setResult(null);
      setUpload(null);
      setReview(null);
      setCancelling(false);
      cancelRequested.current = false;
      reviewedSeq.current = 0;
      setRunId(null);
      clearRunId(project.id);
      setPhase('starting');

      let created;
      try {
        created = await startRun(project.id, inputs, counts);
      } catch (error) {
        if (!alive.current) return;
        setPhase('idle');
        setNotice(noticeFromApiError(error instanceof ApiError ? error : new ApiError(0, '')));
        return;
      }
      if (!alive.current) return;
      setRunId(created.runId);
      saveRunId(project.id, created.runId);

      const queue = files.flatMap((entry) => entry.files.map((file) => ({ field: entry.field, file })));
      if (queue.length > 0) {
        setPhase('uploading');
        try {
          for (const [index, item] of queue.entries()) {
            if (cancelRequested.current) {
              cancelRun(created.runId);
              clearRunId(project.id);
              if (!alive.current) return;
              setRunId(null);
              setUpload(null);
              setCancelling(false);
              setPhase('idle');
              setNotice(cancelledNotice());
              return;
            }
            setUpload({ done: index, total: queue.length });
            await uploadFile(created.runId, item.field, item.file);
          }
        } catch (error) {
          // The run would wait for a file that never arrives, so release it.
          cancelRun(created.runId);
          clearRunId(project.id);
          if (!alive.current) return;
          setRunId(null);
          setUpload(null);
          setPhase('idle');
          setNotice(noticeFromApiError(error instanceof ApiError ? error : new ApiError(0, '')));
          return;
        }
        if (!alive.current) return;
        setUpload(null);
      }
      setPhase('running');
    },
    [project],
  );

  /** Sends the reviewer's decision. The rest of the run arrives in the same event stream. */
  const decide = useCallback(
    async (decision, feedback) => {
      if (deciding || phase !== 'waiting') return;
      setDeciding(true);
      setNotice(null);
      try {
        await submitDecision(runId, decision, feedback);
        if (!alive.current) return;
        setReview(null);
        setPhase('running');
      } catch (error) {
        if (!alive.current) return;
        const failure = error instanceof ApiError ? error : new ApiError(0, '');
        if (failure.status === 409 || failure.status === 404) {
          inspect(runId); // the run has moved on or ended: show how
        } else {
          setNotice(decisionNotice(failure)); // the draft keeps waiting
        }
      } finally {
        if (alive.current) setDeciding(false);
      }
    },
    [deciding, phase, runId, inspect],
  );

  /** Stops the run: the server cancels it and aborts its request to the agents service. */
  const cancel = useCallback(async () => {
    if (cancelling) return;
    if (phase === 'uploading') {
      cancelRequested.current = true; // the upload loop stops before the next file
      setCancelling(true);
      return;
    }
    if (phase !== 'running' && phase !== 'waiting') return;
    setCancelling(true);
    await cancelRun(runId);
    if (!alive.current) return;
    await inspect(runId); // the stream normally reports the end too; this covers a stream that is not connected
    if (alive.current) setCancelling(false);
  }, [cancelling, phase, runId, inspect]);

  const canCancel = phase === 'uploading' || phase === 'running' || phase === 'waiting';
  const active = phase === 'starting' || phase === 'uploading' || phase === 'running' || phase === 'waiting';

  return {
    phase,
    active,
    runId,
    result,
    notice,
    upload,
    review,
    deciding,
    decide,
    cancel,
    cancelling,
    canCancel,
    statuses: stream.statuses,
    events: stream.events,
    ended: stream.ended,
    connection: stream.connection,
    submit,
    reload: () => inspect(runId),
  };
}
