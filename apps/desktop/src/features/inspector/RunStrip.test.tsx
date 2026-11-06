import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunStrip } from './RunStrip';
import { initialTypedRun, reduceTypedRun, type TypedRunState } from './typedRunReducer';

function build(events: unknown[]): TypedRunState {
  // Reality always leads with run-accepted (Rust emits it before anything) — since S8 only that
  // event may seed a virgin strip, so the builder mirrors the real stream.
  const accepted = { runId: (events[0] as { runId: string }).runId, event: { type: 'run-accepted' } };
  return [accepted, ...events].reduce((s: TypedRunState, e) => reduceTypedRun(s, e as never), initialTypedRun());
}

test('shows a spinner for a started-but-not-ended stage, pending for the rest', () => {
  const running = build([
    { runId: 'r1', event: { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['implementer', 'reviewer'] } },
    { runId: 'r1', event: { type: 'stage-start', name: 'implementer', index: 0, of: 2 } },
  ]);
  render(<RunStrip state={running} onCancel={() => {}} />);
  expect(screen.getByTestId('stage-0')).toHaveAttribute('data-phase', 'running');
  expect(screen.getByTestId('stage-1')).toHaveAttribute('data-phase', 'pending');
});

test('marks a completed stage done', () => {
  const done = build([
    { runId: 'r1', event: { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['a'] } },
    { runId: 'r1', event: { type: 'stage-start', name: 'a', index: 0, of: 1 } },
    { runId: 'r1', event: { type: 'stage-end', name: 'a', index: 0, of: 1, outcome: 'completed' } },
  ]);
  render(<RunStrip state={done} onCancel={() => {}} />);
  expect(screen.getByTestId('stage-0')).toHaveAttribute('data-phase', 'done');
});

test('renders a warning banner for an exposed-credential advisory', () => {
  const warned = build([
    { runId: 'r1', event: { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['a'] } },
    { runId: 'r1', event: { type: 'warning', message: "codex's subscription credential is visible to the agent" } },
  ]);
  render(<RunStrip state={warned} onCancel={() => {}} />);
  expect(screen.getByTestId('run-warning')).toHaveTextContent('visible to the agent');
});

test('renders terminal: PR link on success', () => {
  const done = build([
    { runId: 'r1', event: { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['a'] } },
    { runId: 'r1', event: { type: 'run-end', prUrl: 'https://x/pr/1' } },
  ]);
  render(<RunStrip state={done} onCancel={() => {}} />);
  expect(screen.getByRole('link', { name: /pr/i })).toHaveAttribute('href', 'https://x/pr/1');
});

test('renders terminal: error message', () => {
  const errored = build([
    { runId: 'r1', event: { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['a'] } },
    { runId: 'r1', event: { type: 'run-error', message: 'boom' } },
  ]);
  render(<RunStrip state={errored} onCancel={() => {}} />);
  expect(screen.getByText(/boom/)).toBeInTheDocument();
});
