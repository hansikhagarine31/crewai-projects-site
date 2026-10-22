// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import InputForm from '../components/InputForm.jsx';
import { initialValues, validateForm } from '../lib/validateInputs.js';
import { demoProject, projects } from './projects.js';
import { samples, sampleValues } from './samples.js';

const all = [...projects, demoProject];

describe('sample inputs', () => {
  it('exist for every project', () => {
    expect(Object.keys(samples).sort()).toEqual(all.map((project) => project.id).sort());
  });

  for (const project of all) {
    it(`${project.id}: the sample passes the form validation`, () => {
      const values = sampleValues(project, initialValues(project));
      const { valid, errors, form } = validateForm(project, values);
      expect({ valid, errors, form }).toEqual({ valid: true, errors: {}, form: null });
    });
  }

  it('use only https addresses, never one with a user name', () => {
    const addresses = all.flatMap((project) => Object.values(samples[project.id].values ?? {}).flat()).filter((value) => /^https?:/.test(value));
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      const url = new URL(address);
      expect(url.protocol).toBe('https:');
      expect(url.username + url.password).toBe('');
    }
  });

  it('turn file samples into File objects with their names and text', async () => {
    const project = projects.find((item) => item.id === 'resume-screening-flow');
    const { resumes } = sampleValues(project, initialValues(project));
    expect(resumes).toHaveLength(3);
    expect(resumes[0]).toBeInstanceOf(File);
    expect(resumes.map((file) => file.name)).toEqual(['resume-strong.txt', 'resume-partial.txt', 'resume-weak.txt']);
    expect(await resumes[2].text()).toContain('sample resume');
  });
});

describe('the Sample input button', () => {
  it('fills the form so that it can be submitted at once', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const project = projects.find((item) => item.id === 'approval-report-flow');
    render(<InputForm project={project} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Sample input' }));
    expect(screen.getByLabelText(/Topic/)).toHaveValue('Vertical farming');
    expect(screen.getByRole('status')).toHaveTextContent('filled with a sample input');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledWith({ topic: 'Vertical farming', audience: 'City planners' });
  });

  it('clears earlier error messages', async () => {
    const user = userEvent.setup();
    const project = projects.find((item) => item.id === 'blog-post-crew');
    render(<InputForm project={project} onSubmit={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText(/is required/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sample input' }));
    expect(screen.queryByText(/is required/)).toBeNull();
  });

  it('lists the sample files of a project with file inputs', async () => {
    const user = userEvent.setup();
    const project = projects.find((item) => item.id === 'data-report-crew');
    render(<InputForm project={project} onSubmit={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Sample input' }));
    expect(screen.getByRole('list', { name: /Selected files/ })).toHaveTextContent('sales.csv');
  });

  it('is disabled while a run is in progress', () => {
    const project = projects.find((item) => item.id === 'blog-post-crew');
    render(<InputForm project={project} active onSubmit={() => {}} />);
    expect(screen.getByRole('button', { name: 'Sample input' })).toBeDisabled();
  });
});
