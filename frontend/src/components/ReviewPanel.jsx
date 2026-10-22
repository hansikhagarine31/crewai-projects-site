import { useEffect, useId, useRef, useState } from 'react';
import SafeMarkdown from './SafeMarkdown.jsx';
import './ReviewPanel.css';

export const FEEDBACK_MAX_LENGTH = 2000;

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** The problem with a piece of feedback, in words, or null when it can be sent. */
export function feedbackProblem(text) {
  const trimmed = text.trim();
  if (!trimmed) return 'Enter feedback to request a revision.';
  if (trimmed.length > FEEDBACK_MAX_LENGTH) return `The feedback must contain at most ${FEEDBACK_MAX_LENGTH} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) return 'The feedback contains characters that are not permitted.';
  return null;
}

/**
 * The draft of a report that waits for a person's decision: approve it, or ask for a revision with feedback.
 *
 * @param {{
 *   review: { draft: string, round: number, revisionsUsed: number, revisionsLeft: number, maxRevisions: number, notes?: string[], expiresAt?: number },
 *   onDecide: (decision: 'approved' | 'revise', feedback: string) => void,
 *   deciding?: boolean,
 * }} props
 */
export default function ReviewPanel({ review, onDecide, deciding = false }) {
  const id = useId();
  const field = useRef(null);
  const heading = useRef(null);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState(null);
  const { draft, round, revisionsUsed, revisionsLeft, maxRevisions, notes = [], expiresAt } = review;

  // The panel appears above the form, so a keyboard user would otherwise have to go back to find it.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  function revise() {
    const problem = feedbackProblem(feedback);
    setError(problem);
    if (problem) {
      field.current?.focus();
      return;
    }
    onDecide('revise', feedback.trim());
  }

  const remaining = `${revisionsLeft} of ${maxRevisions} revision ${maxRevisions === 1 ? 'round' : 'rounds'} remain${revisionsLeft === 1 ? 's' : ''}`;
  const count = feedback.trim().length;

  return (
    <section className="review" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} ref={heading} tabIndex={-1} className="review__heading">
        Review the draft
      </h2>
      <p className="review__summary">
        Draft {round}. {remaining}.
        {expiresAt ? ` The run waits for a decision until ${clock.format(new Date(expiresAt))}; after that it ends and the draft is deleted.` : ''}
      </p>

      {notes.length > 0 && (
        <div className="review__notes">
          <h3 className="review__notes-heading">Notes on this draft</h3>
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="review__draft" role="region" aria-label={`Draft ${round}`} tabIndex={0}>
        <SafeMarkdown>{draft}</SafeMarkdown>
      </div>

      <div className="review__decision">
        <div className="review__approve">
          <button type="button" className="button" disabled={deciding} onClick={() => onDecide('approved', '')}>
            Approve
          </button>
          <span className="field__hint">Approving publishes the report as final.md.</span>
        </div>

        <div className="review__revise">
          <label className="field__label" htmlFor={`${id}-feedback`}>
            Feedback for a revision <span className="field__meta">(required to revise)</span>
          </label>
          <textarea
            ref={field}
            id={`${id}-feedback`}
            className="input input--area"
            rows={4}
            value={feedback}
            disabled={deciding}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
            onChange={(event) => {
              setFeedback(event.target.value);
              if (error) setError(null);
            }}
          />
          <p id={`${id}-hint`} className="field__hint">
            {count} of {FEEDBACK_MAX_LENGTH} characters. The feedback guides the wording and content; the revision still uses only the research.
            {revisionsLeft === 0 &&
              ` No revision rounds remain. If you request another revision, the run ends without approval and the last draft is returned as draft.md.`}
          </p>
          {error && (
            <p id={`${id}-error`} className="field__error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="button button--quiet" disabled={deciding} onClick={revise}>
            Revise
          </button>
        </div>
      </div>
    </section>
  );
}
