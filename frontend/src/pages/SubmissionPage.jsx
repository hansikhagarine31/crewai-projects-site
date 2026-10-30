import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle.js';
import './SubmissionPage.css';

const AGENTS = [
  { num: 1, id: 'blog-post-crew', title: 'Blog Post Crew', pattern: 'Sequential' },
  { num: 2, id: 'competitor-analysis-crew', title: 'Competitor Analysis Crew', pattern: 'Hierarchical' },
  { num: 3, id: 'meeting-notes-crew', title: 'Meeting Notes Crew', pattern: 'Parallel tasks' },
  { num: 4, id: 'data-report-crew', title: 'Data Report Crew', pattern: 'Structured output' },
  { num: 5, id: 'customer-support-flow', title: 'Customer Support Flow', pattern: 'Router flow' },
  { num: 6, id: 'resume-screening-flow', title: 'Resume Screening Flow', pattern: 'Router flow' },
  { num: 7, id: 'bug-triage-flow', title: 'Bug Triage Flow', pattern: 'Router + Crews' },
  { num: 8, id: 'content-repurposing-flow', title: 'Content Repurposing Flow', pattern: 'and_ Join Flow' },
  { num: 9, id: 'lead-qualification-flow', title: 'Lead Qualification Flow', pattern: 'Router + Crews' },
  { num: 10, id: 'approval-report-flow', title: 'Approval Report Flow', pattern: 'Human feedback' },
];

export default function SubmissionPage() {
  usePageTitle('Submission & Pre-Submission Guide');

  const [selectedAgent, setSelectedAgent] = useState('1');
  const [testInput, setTestInput] = useState('Artificial intelligence in healthcare');
  const [testing, setTesting] = useState(false);
  const [testResponse, setTestResponse] = useState(null);

  const [backendUrl, setBackendUrl] = useState('https://crewai-server.onrender.com');
  const [repoUrl, setRepoUrl] = useState('https://github.com/username/crewai-projects-site');
  const [copied, setCopied] = useState(false);

  const [checks, setChecks] = useState({
    postman: false,
    jsonFormat: false,
    allRoutes: false,
    redirects: false,
    txtFile: false,
  });

  const toggleCheck = (key) => {
    setChecks((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResponse(null);
    try {
      const res = await fetch(`/agent${selectedAgent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: testInput }),
      });
      const data = await res.json();
      setTestResponse({
        status: res.status,
        statusText: res.statusText,
        body: data,
      });
    } catch (err) {
      setTestResponse({
        status: 'Error',
        statusText: err.message,
        body: { error: 'Failed to connect to backend service.' },
      });
    } finally {
      setTesting(false);
    }
  };

  const submissionText = `${backendUrl.trim()}\n${repoUrl.trim()}`;

  const copySubmissionText = () => {
    navigator.clipboard.writeText(submissionText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main id="main" className="submission-page">
      <header className="submission-page__header">
        <Link to="/" className="submission-page__back">
          ← Back to projects
        </Link>
        <h1 className="submission-page__title">Assignment Submission & Pre-Submission Guide</h1>
        <p className="submission-page__lede">
          Detailed technical requirements, API route specifications, and submission instructions for the 10 CrewAI projects
          powered by the Node.js Express backend.
        </p>
      </header>

      {/* PART 1 */}
      <section className="submission-section">
        <h2>
          <span className="submission-badge">1</span>
          Part 1: Node.js Backend Service
        </h2>
        <p>
          The application uses a high-performance Node.js Express server as its public gateway. In accordance with the
          assignment evaluation criteria, the server implements dedicated routes from <code>/agent1</code> to <code>/agent10</code>.
        </p>

        <table className="submission-table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Project Title</th>
              <th>Pattern</th>
              <th>Browser GET Redirect</th>
            </tr>
          </thead>
          <tbody>
            {AGENTS.map((agent) => (
              <tr key={agent.num}>
                <td><code>/agent{agent.num}</code></td>
                <td>{agent.title}</td>
                <td>{agent.pattern}</td>
                <td>
                  <Link to={`/projects/${agent.id}`}>
                    /projects/{agent.id}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ fontSize: '1.05rem', margin: '20px 0 8px' }}>POST Route Contract</h3>
        <p>Every route accepts an HTTP POST request with a single text input encoded in JSON:</p>
        <div className="submission-code-block">
          {`POST /agent1\nContent-Type: application/json\n\n{\n  "input": "Write an overview of AI in medicine."\n}`}
        </div>

        <p style={{ marginTop: '12px' }}>The server returns an HTTP 200 response with the output format:</p>
        <div className="submission-code-block">
          {`{\n  "output": "..."\n}`}
        </div>

        <h3 style={{ fontSize: '1.05rem', margin: '20px 0 8px' }}>GET Route Redirect</h3>
        <p>
          Visiting any route such as <code>/agent1</code> directly in a browser (HTTP GET) issues an HTTP 302 redirect to the
          interactive project page (e.g. <code>/projects/blog-post-crew</code>).
        </p>
      </section>

      {/* INTERACTIVE ROUTE TESTER */}
      <section className="submission-section">
        <h2>
          <span className="submission-badge submission-badge--blue">⚡</span>
          Live Route Tester & Postman Verification
        </h2>
        <p>
          Verify the backend response directly from your browser before testing in Postman or submitting.
        </p>

        <div className="submission-tester">
          <div className="submission-tester__row">
            <select
              className="submission-select"
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              aria-label="Select Agent"
            >
              {AGENTS.map((a) => (
                <option key={a.num} value={a.num}>
                  /agent{a.num} — {a.title}
                </option>
              ))}
            </select>

            <input
              type="text"
              className="submission-input"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              placeholder="Enter test input string"
              aria-label="Input text"
            />

            <button
              type="button"
              className="submission-btn"
              onClick={handleTest}
              disabled={testing || !testInput.trim()}
            >
              {testing ? 'Executing…' : 'Send POST Request'}
            </button>
          </div>

          {testResponse && (
            <div className="submission-output">
              <strong>Status: {testResponse.status} {testResponse.statusText}</strong>
              <pre style={{ marginTop: '8px' }}>{JSON.stringify(testResponse.body, null, 2)}</pre>
            </div>
          )}
        </div>
      </section>

      {/* PART 2 */}
      <section className="submission-section">
        <h2>
          <span className="submission-badge submission-badge--green">2</span>
          Part 2: CrewAI GitHub Repository
        </h2>
        <p>
          Only one repository is required for this submission: the CrewAI repository (no AutoGen projects or repositories are
          required).
        </p>
        <ul style={{ paddingLeft: '20px', marginTop: '10px', lineHeight: 1.6 }}>
          <li>Repository contains the complete multi-agent project with full version history.</li>
          <li>Assignments are evaluated based on both the live deployed backend link and the GitHub repository code.</li>
        </ul>
      </section>

      {/* PART 3 */}
      <section className="submission-section">
        <h2>
          <span className="submission-badge">3</span>
          Part 3: Submission File (.txt)
        </h2>
        <p>
          Prepare a plain text file (<code>.txt</code>) containing the live backend link and your GitHub repository link.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px', marginTop: '14px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, marginBottom: '6px' }}>
              Deployed Backend URL (not frontend):
            </label>
            <input
              type="text"
              className="submission-input"
              style={{ width: '100%' }}
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, marginBottom: '6px' }}>
              CrewAI GitHub Repository URL:
            </label>
            <input
              type="text"
              className="submission-input"
              style={{ width: '100%' }}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </div>
        </div>

        <div className="submission-file-preview">
          <span style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: '8px' }}>
            submission.txt preview (no leading or trailing whitespace):
          </span>
          <code>{backendUrl.trim()}</code>
          <code>{repoUrl.trim()}</code>
        </div>

        <button
          type="button"
          className="submission-btn"
          style={{ marginTop: '14px' }}
          onClick={copySubmissionText}
        >
          {copied ? 'Copied to Clipboard!' : 'Copy submission.txt Content'}
        </button>
      </section>

      {/* PRE-SUBMISSION CHECKLIST */}
      <section className="submission-section">
        <h2>
          <span className="submission-badge submission-badge--blue">✓</span>
          Pre-Submission Checklist
        </h2>
        <p>Complete this verification checklist prior to final submission:</p>

        <div className="submission-checklist">
          <label className={`submission-checklist__item ${checks.postman ? 'is-checked' : ''}`}>
            <input
              type="checkbox"
              className="submission-checklist__checkbox"
              checked={checks.postman}
              onChange={() => toggleCheck('postman')}
            />
            <div className="submission-checklist__text">
              <strong>Postman Request Verification</strong>
              <span>Configured method as POST with JSON body <code>{`{"input": "..."}`}</code>.</span>
            </div>
          </label>

          <label className={`submission-checklist__item ${checks.jsonFormat ? 'is-checked' : ''}`}>
            <input
              type="checkbox"
              className="submission-checklist__checkbox"
              checked={checks.jsonFormat}
              onChange={() => toggleCheck('jsonFormat')}
            />
            <div className="submission-checklist__text">
              <strong>JSON Output Structure</strong>
              <span>Verified response returns HTTP 200 with JSON key <code>output</code>.</span>
            </div>
          </label>

          <label className={`submission-checklist__item ${checks.allRoutes ? 'is-checked' : ''}`}>
            <input
              type="checkbox"
              className="submission-checklist__checkbox"
              checked={checks.allRoutes}
              onChange={() => toggleCheck('allRoutes')}
            />
            <div className="submission-checklist__text">
              <strong>All 10 Routes Active</strong>
              <span>Endpoints <code>/agent1</code> through <code>/agent10</code> are verified and responding.</span>
            </div>
          </label>

          <label className={`submission-checklist__item ${checks.redirects ? 'is-checked' : ''}`}>
            <input
              type="checkbox"
              className="submission-checklist__checkbox"
              checked={checks.redirects}
              onChange={() => toggleCheck('redirects')}
            />
            <div className="submission-checklist__text">
              <strong>GET Route Redirections</strong>
              <span>Opening <code>/agent1</code> in a browser forwards to <code>/projects/blog-post-crew</code>.</span>
            </div>
          </label>

          <label className={`submission-checklist__item ${checks.txtFile ? 'is-checked' : ''}`}>
            <input
              type="checkbox"
              className="submission-checklist__checkbox"
              checked={checks.txtFile}
              onChange={() => toggleCheck('txtFile')}
            />
            <div className="submission-checklist__text">
              <strong>Submission File Prepared</strong>
              <span>Plain <code>.txt</code> file created with exact backend link without surrounding spaces.</span>
            </div>
          </label>
        </div>
      </section>
    </main>
  );
}
