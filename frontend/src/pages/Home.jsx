import { Link } from 'react-router-dom';
import logo from '../assets/crewai-logo.png';
import ConnectionStatus from '../components/ConnectionStatus.jsx';
import Legend from '../components/Legend.jsx';
import { projects } from '../data/projects.js';
import { usePageTitle } from '../hooks/usePageTitle.js';
import './Home.css';

export default function Home() {
  usePageTitle('');

  return (
    <main id="main">
      <header className="hero">
        <div className="lockup">
          <img src={logo} alt="CrewAI" />
          <span className="lockup__divider" aria-hidden="true" />
          <h1>Projects</h1>
        </div>

        <p className="lede">
          Ten projects built with CrewAI Crews and Flows. Each page states the problem a project addresses and shows its flow
          diagram.
        </p>

        <nav className="index" aria-label="Projects">
          {projects.map((project, i) => (
            <Link key={project.id} to={`/projects/${project.id}`} className="index__item" style={{ '--i': i }}>
              <b className="mono">{String(project.number).padStart(2, '0')}</b>
              <span>{project.title}</span>
            </Link>
          ))}
        </nav>

        <Legend />
      </header>

      <footer className="site-footer">
        <ConnectionStatus />
        <p className="site-footer__link">
          <Link to="/projects/demo">Pipeline demonstration</Link>
        </p>
      </footer>
    </main>
  );
}
