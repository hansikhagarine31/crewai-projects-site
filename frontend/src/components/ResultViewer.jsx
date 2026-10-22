import { useState } from 'react';
import { apiUrl } from '../lib/apiBase.js';
import { formatBytes } from '../lib/validateInputs.js';
import SafeMarkdown from './SafeMarkdown.jsx';
import './ResultViewer.css';

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for browsers or contexts without the asynchronous clipboard.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Copy failed');
}

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Shows a finished run: the Markdown result, buttons to copy or download it, and the
 * output files registered by the server.
 *
 * @param {{
 *   result: null | { cached?: boolean, zipUrl?: string | null, result: { markdown: string } | null, files: Array<{ name: string, size: number, contentType: string, url: string }> },
 *   projectId: string,
 * }} props
 */
export default function ResultViewer({ result, projectId }) {
  const [copyState, setCopyState] = useState('');
  const markdown = result?.result?.markdown;

  if (!result || typeof markdown !== 'string') {
    return <p className="panel__placeholder">The result and any files will appear here when a run has finished.</p>;
  }

  async function copy() {
    try {
      await copyText(markdown);
      setCopyState('The result has been copied to the clipboard.');
    } catch {
      setCopyState('The result could not be copied. Select the text and copy it manually.');
    }
  }

  return (
    <div className="result">
      {result.cached && (
        <p className="result__note">
          This result was taken from a stored copy of an earlier run with identical inputs. No new run was made.
        </p>
      )}

      <div className="result__actions">
        <button type="button" className="button button--quiet" onClick={copy}>
          Copy
        </button>
        <button type="button" className="button button--quiet" onClick={() => downloadText(`${projectId}-result.md`, markdown)}>
          Download
        </button>
        <span className="visually-hidden" role="status">
          {copyState}
        </span>
        {copyState.includes('could not') && <span className="result__copy-error">{copyState}</span>}
      </div>

      <article className="result__body" aria-label="Result">
        <SafeMarkdown>{markdown}</SafeMarkdown>
      </article>

      {result.files.length > 0 && (
        <section className="result__files" aria-labelledby="files-heading">
          <h3 id="files-heading" className="result__files-heading">
            Output files
          </h3>
          <ul>
            {result.files.map((file) => (
              <li key={file.name}>
                <a href={apiUrl(file.url)} download={file.name}>
                  {file.name}
                </a>
                <span className="field__meta">
                  {' '}
                  ({formatBytes(file.size)}, {file.contentType.split(';')[0]})
                </span>
              </li>
            ))}
          </ul>
          {result.zipUrl && (
            <p className="result__zip">
              <a href={apiUrl(result.zipUrl)} download>
                Download all files (zip)
              </a>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
