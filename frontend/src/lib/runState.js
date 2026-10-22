/**
 * Folding of run events into display state. Pure, so it can be tested without a browser.
 *
 * @typedef {Object} RunEvent
 * @property {string} runId
 * @property {string} nodeId
 * @property {'pending' | 'running' | 'done' | 'error' | 'waiting' | 'skipped'} status
 * @property {string} message
 * @property {number} ts
 *
 * @typedef {Object} RunState
 * @property {Record<string, string>} statuses  Latest status per nodeId.
 * @property {Array<{ seq: number, event: RunEvent }>} events  In arrival order.
 * @property {number} lastSeq  Highest event id applied; replayed events at or below it are ignored.
 * @property {{ status: string, error: string | null } | null} ended
 */

/** @returns {RunState} */
export const initialRunState = () => ({ statuses: {}, events: [], lastSeq: 0, ended: null });

/**
 * Applies one event. An event that was already applied (same or lower id, as after a
 * reconnection that replays history) leaves the state unchanged.
 * @param {RunState} state
 * @param {number} seq
 * @param {RunEvent} event
 * @returns {RunState}
 */
export function applyEvent(state, seq, event) {
  if (Number.isFinite(seq) && seq <= state.lastSeq) return state;
  return {
    ...state,
    statuses: { ...state.statuses, [event.nodeId]: event.status },
    events: [...state.events, { seq, event }],
    lastSeq: Number.isFinite(seq) ? seq : state.lastSeq,
  };
}

/** @returns {RunState} */
export const applyEnd = (state, end) => ({ ...state, ended: { status: end.status, error: end.error ?? null } });

export const STATUS_TEXT = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  waiting: 'Waiting for input',
  skipped: 'Skipped',
};

const KNOWN = new Set(Object.keys(STATUS_TEXT));

/** The status of a node, treating a missing or unrecognised value as pending. */
export const statusOf = (statuses, id) => (KNOWN.has(statuses[id]) ? statuses[id] : 'pending');
