// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ProjectPage from './ProjectPage.jsx';

const page = (id) =>
  render(
    <MemoryRouter initialEntries={[`/projects/${id}`]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('ProjectPage: the resume screening note', () => {
  it('shows a visible note that the output is advice to a human reviewer and not a hiring decision', () => {
    page('resume-screening-flow');
    const note = screen.getByRole('note', { name: 'Important note' });
    expect(note).toBeVisible();
    expect(note).toHaveTextContent('advice to a human reviewer');
    expect(note).toHaveTextContent('not a hiring decision');
  });

  it('is shown before the diagram and the form', () => {
    page('resume-screening-flow');
    const note = screen.getByRole('note', { name: 'Important note' });
    const form = screen.getByRole('form', { name: /inputs/ });
    expect(note.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers one to five resumes of type .pdf or .txt', () => {
    page('resume-screening-flow');
    const picker = screen.getByLabelText(/Resumes/);
    expect(picker).toHaveAttribute('accept', '.pdf,.txt');
    expect(picker).toHaveAttribute('multiple');
    expect(screen.getByText(/Up to 5 files\. Accepted types: \.pdf, \.txt/)).toBeInTheDocument();
    expect(screen.getByText(/Scanned documents \(images\) cannot be read/)).toBeInTheDocument();
  });

  it('shows no such note on other projects', () => {
    page('blog-post-crew');
    expect(screen.queryByRole('note', { name: 'Important note' })).not.toBeInTheDocument();
  });
});

describe('ProjectPage: the bug triage note', () => {
  it('says that nothing is posted to GitHub', () => {
    page('bug-triage-flow');
    expect(screen.getByRole('note', { name: 'Important note' })).toHaveTextContent('Nothing is posted to GitHub');
  });

  it('asks for a title, a description and an optional documentation address', () => {
    page('bug-triage-flow');
    expect(screen.getByLabelText(/Issue title/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Issue description/).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(/Documentation website/)).toHaveAttribute('type', 'url');
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });
});

describe('ProjectPage: the lead qualification note', () => {
  it('says that no email is sent', () => {
    page('lead-qualification-flow');
    expect(screen.getByRole('note', { name: 'Important note' })).toHaveTextContent('No email is sent');
  });

  it('asks for the lead name, the company name and the website address', () => {
    page('lead-qualification-flow');
    expect(screen.getByLabelText(/Lead name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Company name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Website address/)).toHaveAttribute('type', 'url');
  });
});
