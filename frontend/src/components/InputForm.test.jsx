// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { demoProject, getProject } from '../data/projects.js';
import InputForm from './InputForm.jsx';

const setup = (project, props = {}) => {
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<InputForm project={project} onSubmit={onSubmit} {...props} />);
  return { onSubmit, user };
};

const textFile = (name, content = 'hello') => new File([content], name, { type: 'text/plain' });

describe('InputForm: rendering', () => {
  it('renders each field type from the project definition', () => {
    const project = {
      id: 'x',
      title: 'Everything',
      inputs: [
        { key: 'a', label: 'Short text', type: 'text', required: true, minLength: 1, maxLength: 50 },
        { key: 'b', label: 'Long text', type: 'text', required: false, maxLength: 4000, multiline: true },
        { key: 'c', label: 'Website', type: 'url', required: true },
        { key: 'd', label: 'Competitor websites', type: 'urls', required: true, minItems: 1, maxItems: 3 },
        { key: 'e', label: 'Attachment', type: 'file', required: false, extensions: ['.txt', '.csv'], maxFiles: 1 },
        { key: 'f', label: 'Tone', type: 'select', required: true, options: [{ value: 'formal', label: 'Formal' }] },
      ],
    };
    setup(project);
    expect(screen.getByLabelText(/Short text/).tagName).toBe('INPUT');
    expect(screen.getByLabelText(/Long text/).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(/^Website/)).toHaveAttribute('type', 'url');
    expect(screen.getByRole('group', { name: /Competitor websites/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Attachment/)).toHaveAttribute('accept', '.txt,.csv');
    expect(screen.getByRole('combobox', { name: /Tone/ })).toBeInTheDocument();
  });

  it('marks fields as required or optional in words, not only with a symbol', () => {
    setup(demoProject);
    expect(screen.getByText('(required)')).toBeInTheDocument();
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('states the limits that apply to files', () => {
    setup(demoProject);
    expect(screen.getByText(/Accepted types: \.txt\. Maximum size: 2 MB per file\./)).toBeInTheDocument();
  });
});

describe('InputForm: validation messages', () => {
  it('reports a missing required field on submit, in formal British English, and does not submit', async () => {
    const { user, onSubmit } = setup(demoProject);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('The topic is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('marks the field invalid, links the message to it and moves focus to it', async () => {
    const { user } = setup(demoProject);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const field = screen.getByLabelText(/Topic/);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain(screen.getByText('The topic is required.').id);
    expect(field).toHaveFocus();
  });

  it('shows no messages before the visitor has interacted', () => {
    setup(demoProject);
    expect(screen.queryByText(/is required/)).not.toBeInTheDocument();
  });

  it('reports a problem when a field is left after typing too little, and clears it when corrected', async () => {
    const project = getProject('blog-post-crew');
    const { user } = setup({ ...project, runnable: true });
    const field = screen.getByLabelText(/Topic/);
    await user.type(field, 'ab');
    await user.tab();
    expect(screen.getByText('The topic must contain at least 3 characters.')).toBeInTheDocument();
    await user.type(field, 'c');
    expect(screen.queryByText(/must contain at least/)).not.toBeInTheDocument();
  });

  it('rejects an address that does not begin with https://', async () => {
    const project = getProject('lead-qualification-flow');
    const { user, onSubmit } = setup({ ...project, runnable: true });
    await user.type(screen.getByLabelText(/Lead name/), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/Website address/), 'http://example.com');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('Enter a web address that begins with https://.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a file of the wrong type, before any upload', async () => {
    const { user, onSubmit } = setup(demoProject);
    await user.type(screen.getByLabelText(/Topic/), 'Farming');
    // applyAccept is off so that the test can supply a type the picker would normally hide.
    const picker = userEvent.setup({ applyAccept: false });
    await picker.upload(screen.getByLabelText(/Notes/), textFile('notes.pdf'));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('The file notes.pdf is not an accepted type. Accepted types: .txt.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a file over 2 MB', async () => {
    const { user, onSubmit } = setup(demoProject);
    await user.type(screen.getByLabelText(/Topic/), 'Farming');
    const large = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText(/Notes/), large);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('The file large.txt exceeds the limit of 2 MB.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asks for one of the alternatives when a project needs either of two inputs', async () => {
    const project = { ...getProject('content-repurposing-flow'), runnable: true };
    const { user, onSubmit } = setup(project);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Provide one of the following: Article address, Article text or Article file.');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Article address/), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe('InputForm: url list', () => {
  const project = getProject('competitor-analysis-crew');

  it('starts with one address and allows up to three', async () => {
    const { user } = setup({ ...project, runnable: true });
    const group = screen.getByRole('group', { name: /Competitor websites/ });
    expect(within(group).getAllByRole('textbox')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add another address' }));
    await user.click(screen.getByRole('button', { name: 'Add another address' }));
    expect(within(group).getAllByRole('textbox')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Add another address' })).not.toBeInTheDocument();
  });

  it('removes an address', async () => {
    const { user } = setup({ ...project, runnable: true });
    await user.click(screen.getByRole('button', { name: 'Add another address' }));
    await user.click(screen.getByRole('button', { name: /Remove address 2/ }));
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('submits the addresses entered', async () => {
    const { user, onSubmit } = setup({ ...project, runnable: true });
    await user.type(screen.getByRole('textbox', { name: /address 1/ }), 'https://a.example/');
    await user.click(screen.getByRole('button', { name: 'Add another address' }));
    await user.type(screen.getByRole('textbox', { name: /address 2/ }), 'https://b.example/');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledWith({ competitors: ['https://a.example/', 'https://b.example/'] });
  });
});

describe('InputForm: files', () => {
  it('lists the chosen file and allows it to be removed', async () => {
    const { user } = setup(demoProject);
    await user.upload(screen.getByLabelText(/Notes/), textFile('notes.txt'));
    const list = screen.getByRole('list', { name: /Selected files/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('notes.txt');
    await user.click(screen.getByRole('button', { name: /Remove notes\.txt/ }));
    expect(screen.queryByRole('list', { name: /Selected files/ })).not.toBeInTheDocument();
  });

  it('submits the valid file with the other values', async () => {
    const { user, onSubmit } = setup(demoProject);
    const notes = textFile('notes.txt');
    await user.type(screen.getByLabelText(/Topic/), 'Farming');
    await user.upload(screen.getByLabelText(/Notes/), notes);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledWith({ topic: 'Farming', notes: [notes] });
  });
});

describe('InputForm: the Run button', () => {
  it('is enabled when no run is active', () => {
    setup(demoProject);
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('is disabled while a run is active, and a submission is ignored', async () => {
    const { user, onSubmit } = setup(demoProject, { active: true });
    const button = screen.getByRole('button', { name: 'Run' });
    expect(button).toBeDisabled();
    expect(screen.getByText('A run is in progress.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Topic/), 'Farming{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is disabled, with the reason, for a project that cannot be run yet', () => {
    setup(demoProject, { unavailableReason: 'This project cannot be run yet.' });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByText('This project cannot be run yet.')).toBeInTheDocument();
  });

  it('submits trimmed-ready values when the form is valid', async () => {
    const { user, onSubmit } = setup(demoProject);
    await user.type(screen.getByLabelText(/Topic/), 'Farming');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledWith({ topic: 'Farming', notes: [] });
  });
});

describe('InputForm: the meeting transcript, pasted or uploaded', () => {
  const project = getProject('meeting-notes-crew');
  const text = 'Priya will update the onboarding guide by Friday.';

  it('offers a text area and a file, and explains which one is used', () => {
    setup(project);
    expect(screen.getByLabelText(/Meeting transcript/).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(/Transcript file/)).toHaveAttribute('accept', '.txt');
    expect(screen.getByText(/If a transcript is also pasted above, the file is used instead\./)).toBeInTheDocument();
  });

  it('asks for one of them when both are empty', async () => {
    const { user, onSubmit } = setup(project);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Provide one of the following: Meeting transcript or Transcript file.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts pasted text alone', async () => {
    const { user, onSubmit } = setup(project);
    await user.type(screen.getByLabelText(/Meeting transcript/), text);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledWith({ transcript: text, transcript_file: [] });
  });

  it('accepts a file alone', async () => {
    const { user, onSubmit } = setup(project);
    const file = textFile('meeting.txt', text);
    await user.upload(screen.getByLabelText(/Transcript file/), file);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledWith({ transcript: '', transcript_file: [file] });
  });

  it('rejects pasted text that is too short', async () => {
    const { user, onSubmit } = setup(project);
    await user.type(screen.getByLabelText(/Meeting transcript/), 'Too short');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('The meeting transcript must contain at least 20 characters.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
