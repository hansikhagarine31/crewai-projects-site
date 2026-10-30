import { Navigate, Route, Routes } from 'react-router-dom';
import Home from './pages/Home.jsx';
import NotFound from './pages/NotFound.jsx';
import ProjectPage from './pages/ProjectPage.jsx';
import SubmissionPage from './pages/SubmissionPage.jsx';
import SiteFooter from './components/SiteFooter.jsx';

const AGENT_PROJECTS = {
  1: 'blog-post-crew',
  2: 'competitor-analysis-crew',
  3: 'meeting-notes-crew',
  4: 'data-report-crew',
  5: 'customer-support-flow',
  6: 'resume-screening-flow',
  7: 'bug-triage-flow',
  8: 'content-repurposing-flow',
  9: 'lead-qualification-flow',
  10: 'approval-report-flow',
};

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/projects/:id" element={<ProjectPage />} />
        <Route path="/submission" element={<SubmissionPage />} />

        {/* Browser redirects: /agent1 to /agent10 forwards to the interactive project page */}
        {Object.entries(AGENT_PROJECTS).map(([num, id]) => (
          <Route key={num} path={`/agent${num}`} element={<Navigate to={`/projects/${id}`} replace />} />
        ))}

        <Route path="*" element={<NotFound />} />
      </Routes>
      <SiteFooter />
    </>
  );
}

