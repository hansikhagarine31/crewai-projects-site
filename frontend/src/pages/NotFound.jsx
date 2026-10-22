import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle.js';

export default function NotFound() {
  usePageTitle('Page not found');
  return (
    <main id="main" className="project">
      <div className="wrap">
        <h1 className="project__title">Page not found</h1>
        <p className="panel__placeholder">The address does not match any page.</p>
        <p>
          <Link to="/" className="project__back">Return to the list of projects</Link>
        </p>
      </div>
    </main>
  );
}
