/**
 * Messages for things that go wrong. Written for the visitor: formal British English,
 * never a stack trace and never raw server text beyond the server's own safe messages.
 *
 * @typedef {Object} Notice
 * @property {'rate-limit' | 'capacity' | 'invalid' | 'failed' | 'cancelled' | 'connection' | 'expired' | 'upload'} kind
 * @property {string} message
 */

/** "30 seconds", "about 42 minutes", "about 2 hours". */
export function formatWait(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} ${Math.ceil(seconds) <= 1 ? 'second' : 'seconds'}`;
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const hours = Math.round(seconds / 3600);
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** @returns {string} For example "You may try again at 15:42 (in about 42 minutes)." */
export function retryMessage(seconds, now = Date.now()) {
  if (seconds === null || seconds === undefined) return 'Please try again later.';
  return `You may try again at ${clock.format(new Date(now + seconds * 1000))} (in ${formatWait(seconds)}).`;
}

/**
 * Converts an ApiError from starting a run or uploading a file into a notice.
 * @returns {Notice}
 */
export function noticeFromApiError(error, now = Date.now()) {
  if (error.status === 429) {
    return { kind: 'rate-limit', message: `The limit on runs for this address has been reached. ${retryMessage(error.retryAfter, now)}` };
  }
  if (error.status === 503) {
    return { kind: 'capacity', message: `The service is running its maximum number of runs. ${retryMessage(error.retryAfter, now)}` };
  }
  if (error.status === 0) {
    return { kind: 'connection', message: 'The server could not be reached. Check the connection and try again.' };
  }
  if (error.status === 400 && Array.isArray(error.details) && error.details.length) {
    const lines = error.details.map((detail) => `${detail.field}: ${detail.message}`);
    return { kind: 'invalid', message: `The server did not accept the inputs. ${lines.join(' ')}` };
  }
  if (error.status >= 400 && error.status < 500) return { kind: 'invalid', message: error.message };
  return { kind: 'failed', message: 'The run could not be started because of a fault on the server. Please try again later.' };
}

/** @returns {Notice} */
export const failedRunNotice = (message) => ({
  kind: 'failed',
  message: message || 'The run failed.',
});

/** @returns {Notice} */
export const cancelledNotice = () => ({ kind: 'cancelled', message: 'The run was cancelled.' });

/** @returns {Notice} */
export const connectionLostNotice = () => ({
  kind: 'connection',
  message: 'The connection to the server was lost. The run may still be in progress or may have finished.',
});

/** @returns {Notice} */
export const expiredNotice = () => ({
  kind: 'expired',
  message: 'The earlier run is no longer available. Results are kept only for a limited time.',
});

/** @returns {Notice} A run that waited for a decision for too long. */
export const reviewExpiredNotice = (message) => ({
  kind: 'expired',
  message: message || 'The report was not reviewed within 30 minutes, so the run has ended and the draft has been deleted.',
});

/** Converts an ApiError from sending a decision into a notice. The draft keeps waiting unless the run has moved on. */
export function decisionNotice(error) {
  if (error.status === 0) return { kind: 'connection', message: 'The server could not be reached. The draft is still waiting; send the decision again.' };
  if (error.status === 503) {
    return { kind: 'capacity', message: 'The service is running its maximum number of runs. The draft is still waiting; please try again shortly.' };
  }
  if (error.status === 400 && Array.isArray(error.details) && error.details.length) {
    return { kind: 'invalid', message: `The decision was not accepted. ${error.details.map((detail) => `${detail.field}: ${detail.message}`).join(' ')}` };
  }
  if (error.status >= 400 && error.status < 500) return { kind: 'invalid', message: error.message };
  return { kind: 'failed', message: 'The decision could not be sent because of a fault on the server. The draft is still waiting; please try again.' };
}
