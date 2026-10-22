// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ReviewPanel, { FEEDBACK_MAX_LENGTH, feedbackProblem } from './ReviewPanel.jsx';

const review = (extra = {}) => ({
  draft: '# Vertical farming\n\nA short **draft** with a [link](https://example.com).',
  round: 1,
  revisionsUsed: 0,
  revisionsLeft: 3,
  maxRevisions: 3,
  notes: [],
  expiresAt: new Date(2030, 0, 1, 14, 35).getTime(),
  ...extra,
});

const setup = (extra = {}, props = {}) => {
  const onDecide = vi.fn();
  const view = render(<ReviewPanel review={review(extra)} onDecide={onDecide} {...props} />);
  return { onDecide, user: userEvent.setup(), ...view };
};

describe('feedbackProblem', () => {
  it('asks for feedback when there is none', () => {
    expect(feedbackProblem('')).toMatch(/Enter feedback/);
    expect(feedbackProblem('   \n ')).toMatch(/Enter feedback/);
  });

  it('accepts feedback up to the limit and refuses more', () => {
    expect(feedbackProblem('x'.repeat(FEEDBACK_MAX_LENGTH))).toBeNull();
    expect(feedbackProblem('x'.repeat(FEEDBACK_MAX_LENGTH + 1))).toMatch(/at most 2000 characters/);
  });

  it('refuses control characters', () => {
    expect(feedbackProblem('a\u0000b')).toMatch(/not permitted/);
  });
});

describe('ReviewPanel', () => {
  it('moves focus to its heading when it appears, so that a keyboard user finds it', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Review the draft' })).toHaveFocus();
  });

  it('shows the draft as formatted text, the round and the revisions left', () => {
    setup();
    const draft = screen.getByRole('region', { name: 'Draft 1' });
    expect(within(draft).getByRole('heading', { name: 'Vertical farming' })).toBeInTheDocument();
    expect(within(draft).getByText('draft').tagName).toBe('STRONG');
    expect(screen.getByRole('heading', { name: 'Review the draft' })).toBeInTheDocument();
    expect(screen.getByText(/Draft 1\. 3 of 3 revision rounds remain\./)).toBeInTheDocument();
  });

  it('says when the run stops waiting', () => {
    setup();
    expect(screen.getByText(/waits for a decision until 14:35; after that it ends and the draft is deleted/)).toBeInTheDocument();
  });

  it('never turns HTML in a draft into elements', () => {
    setup({ draft: '# Title\n\n<script>window.hacked = true</script><img src=x onerror="window.hacked = true">' });
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(window.hacked).toBeUndefined();
  });

  it('lists the notes on the draft when there are any', () => {
    setup({ notes: ['1 fact(s) were dropped because they did not cite a source that was found.'] });
    expect(screen.getByRole('heading', { name: 'Notes on this draft' })).toBeInTheDocument();
    expect(screen.getByText(/1 fact\(s\) were dropped/)).toBeInTheDocument();
  });

  it('approves without feedback', async () => {
    const { onDecide, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('approved', '');
  });

  it('refuses a revision without feedback, says why and moves focus to the box', async () => {
    const { onDecide, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter feedback to request a revision.');
    const box = screen.getByLabelText(/Feedback for a revision/);
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
  });

  it('refuses feedback made only of spaces', async () => {
    const { onDecide, user } = setup();
    await user.type(screen.getByLabelText(/Feedback for a revision/), '    ');
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('sends the feedback, trimmed, with a revision', async () => {
    const { onDecide, user } = setup();
    await user.type(screen.getByLabelText(/Feedback for a revision/), '  Please shorten the introduction.  ');
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(onDecide).toHaveBeenCalledWith('revise', 'Please shorten the introduction.');
  });

  it('clears the message as soon as the feedback is edited', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    await user.type(screen.getByLabelText(/Feedback for a revision/), 'a');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses feedback that is too long', async () => {
    const { onDecide, user } = setup();
    const box = screen.getByLabelText(/Feedback for a revision/);
    await user.click(box);
    await user.paste('x'.repeat(FEEDBACK_MAX_LENGTH + 1));
    expect(screen.getByText(/2001 of 2000 characters/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('at most 2000 characters');
  });

  it('warns that the run will end without approval when no revision rounds remain', async () => {
    const { onDecide, user } = setup({ revisionsUsed: 3, revisionsLeft: 0, round: 4 });
    expect(screen.getByText(/0 of 3 revision rounds remain\./)).toBeInTheDocument();
    expect(screen.getByText(/ends without approval and the last draft is returned as draft\.md/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Feedback for a revision/), 'One more change.');
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(onDecide).toHaveBeenCalledWith('revise', 'One more change.');
  });

  it('uses the singular for the last round', () => {
    setup({ revisionsLeft: 1, revisionsUsed: 2, round: 3 });
    expect(screen.getByText(/1 of 3 revision rounds remains\./)).toBeInTheDocument();
  });

  it('disables both buttons and the box while a decision is being sent', () => {
    setup({}, { deciding: true });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revise' })).toBeDisabled();
    expect(screen.getByLabelText(/Feedback for a revision/)).toBeDisabled();
  });
});
