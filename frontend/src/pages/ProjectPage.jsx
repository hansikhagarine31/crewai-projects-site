import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import FlowDiagram from '../components/FlowDiagram.jsx';
import InputForm from '../components/InputForm.jsx';
import Legend from '../components/Legend.jsx';
import ReviewPanel from '../components/ReviewPanel.jsx';
import ResultViewer from '../components/ResultViewer.jsx';
import RunNotice from '../components/RunNotice.jsx';
import { getProject, projects } from '../data/projects.js';
import { usePageTitle } from '../hooks/usePageTitle.js';
import { useProjectRun } from '../hooks/useProjectRun.js';
import { phaseAnnouncement, statusLine } from '../lib/statusLine.js';
import NotFound from './NotFound.jsx';
import './ProjectPage.css';

const UNAVAILABLE = 'This project cannot be run yet. Its runner has not been added to the agents service.';

function ProjectView({ project }) {
  usePageTitle(project.title);
  const run = useProjectRun(project);
  const hasResult = run.result !== null;
  const position = projects.findIndex((item) => item.id === project.id);
  const previous = projects[position - 1];
  const next = projects[position + 1];

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [project.id]);

  const line = statusLine({ project, phase: run.phase, upload: run.upload, events: run.events, connection: run.connection, hasResult });

  return (
    <main id="main" className="project">
      <div className="wrap">
        <Link to="/" className="project__back">
          All projects
        </Link>

        <header className="project__head">
          <span className="project__number mono" aria-hidden="true">
            {project.number > 0 ? String(project.number).padStart(2, '0') : '--'}
          </span>
          <div>
            <h1 className="project__title">
              {project.number > 0 && <span className="visually-hidden">Project {project.number}: </span>}
              {project.title}
            </h1>
            <div className="chips">
              <b className="chip chip--kind">{project.kind}</b>
              <span className="chip">{project.pattern}</span>
            </div>
          </div>
        </header>

        <section className="problem" aria-labelledby="problem-label">
          <span id="problem-label" className="label">
            Problem
          </span>
          <p>{project.problem}</p>
        </section>

        {project.notice && (
          <aside className="project-notice" role="note" aria-label="Important note">
            <strong>Note:</strong> {project.notice}
          </aside>
        )}

        <section className="solution" aria-labelledby="solution-label">
          <span id="solution-label" className="label">
            Solution
          </span>
          <FlowDiagram project={project} statuses={run.statuses} />
          <p className="run-status" aria-live="off">
            {line}
          </p>
          {run.canCancel && (
            <p className="run-cancel">
              <button type="button" className="button button--quiet" onClick={run.cancel} disabled={run.cancelling} aria-busy={run.cancelling || undefined}>
                {run.cancelling ? 'Cancelling' : 'Cancel run'}
              </button>
            </p>
          )}
          <div className="visually-hidden" role="status">
            {phaseAnnouncement({ phase: run.phase, hasResult })}
          </div>
          <p className="free">Free tools: {project.freeTools}</p>
          <Legend />
        </section>

        <RunNotice notice={run.notice} onReload={run.reload} />

        {run.phase === 'waiting' && run.review && (
          <ReviewPanel key={run.review.round} review={run.review} deciding={run.deciding} onDecide={run.decide} />
        )}

        <div className="panels">
          <section className="panel" aria-labelledby="input-heading">
            <h2 id="input-heading" className="panel__heading">
              Input
            </h2>
            <InputForm project={project} active={run.active} unavailableReason={project.runnable ? undefined : UNAVAILABLE} onSubmit={run.submit} />
          </section>

          <section className="panel" aria-labelledby="output-heading">
            <h2 id="output-heading" className="panel__heading">
              Output
            </h2>
            <ResultViewer result={run.result} projectId={project.id} />
          </section>
        </div>

        {position >= 0 && (
          <nav className="project__nav" aria-label="Other projects">
            {previous ? (
              <Link to={`/projects/${previous.id}`}>
                <span className="label">Previous</span>
                {previous.title}
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link to={`/projects/${next.id}`} className="project__next">
                <span className="label">Next</span>
                {next.title}
              </Link>
            )}
          </nav>
        )}
      </div>
    </main>
  );
}

export default function ProjectPage() {
  const { id } = useParams();
  const project = getProject(id);
  return project ? <ProjectView key={project.id} project={project} /> : <NotFound />;
}
