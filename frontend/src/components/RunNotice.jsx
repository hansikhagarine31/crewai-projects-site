import './RunNotice.css';

/**
 * A problem with a run, in words the visitor can act on.
 * @param {{ notice: import('../lib/notices.js').Notice | null, onReload?: () => void }} props
 */
export default function RunNotice({ notice, onReload }) {
  if (!notice) return null;
  return (
    <div className={`notice notice--${notice.kind}`} role="alert">
      <p>{notice.message}</p>
      {notice.kind === 'connection' && onReload && (
        <button type="button" className="button button--quiet" onClick={onReload}>
          Reload result
        </button>
      )}
    </div>
  );
}
