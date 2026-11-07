import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunDetail } from './RunDetail';
import type { RunDetail as RunDetailT, StageDetail } from '../../vanguard-output';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => vi.unstubAllGlobals());

function stage(diffOmitted?: StageDetail['record']['diffOmitted'], diff?: string): StageDetail {
  return {
    record: {
      taskId: 'task-1', completed: true, exitReason: 'completed', turns: 1,
      worktreePath: '/tmp/wt', worktreePreserved: false, finalText: 'done',
      timestamp: '2026-07-06T19:12:02.000Z', diffOmitted,
    },
    diff,
  };
}

function showDiff(stages: StageDetail[]) {
  const detail: RunDetailT = { taskId: 'task-1', timestamp: stages[0].record.timestamp, stages };
  render(<RunDetail detail={detail} project="/repo" />);
  fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
}

test.each(['secret-blocked', 'secret-scan'] as const)('explains a diff withheld for %s', (reason) => {
  showDiff([stage(reason)]);
  expect(screen.getByText(`diff withheld: ${reason}`)).toBeInTheDocument();
  expect(screen.queryByText('No diff captured.')).not.toBeInTheDocument();
});

test('withheld stages hide stale diffs while normal stages still show their diff', () => {
  showDiff([stage('secret-blocked', '+sensitive stale diff'), stage(undefined, '+safe diff')]);
  expect(screen.queryByText('+sensitive stale diff')).not.toBeInTheDocument();
  expect(screen.getByText('+safe diff')).toBeInTheDocument();
});

test('shows the empty state when there is no diff or omission reason', () => {
  showDiff([stage()]);
  expect(screen.getByText('No diff captured.')).toBeInTheDocument();
});

test('T29: overview renders verdict and all structured findings as text', async () => {
  const reviewer = stage();
  reviewer.record.stage = 'reviewer';
  reviewer.record.verdict = 'changes';
  reviewer.record.findings = [
    { severity: 'high', kind: 'security', title: 'Secret leak', evidence: '<img src=x onerror=alert(1)>' },
    { severity: 'medium', kind: 'correctness', title: 'Wrong result', evidence: 'return undefined' },
  ];
  render(<RunDetail detail={{ taskId: 'task-1', timestamp: reviewer.record.timestamp, stages: [reviewer] }} project="/repo" />);
  expect(screen.getByText('verdict: changes')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /reviewer/ }));
  for (const finding of reviewer.record.findings) {
    expect(await screen.findByText(finding.severity)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(finding.kind))).toHaveTextContent(finding.title);
    expect(screen.getByText(finding.evidence)).toBeInTheDocument();
  }
  expect(document.querySelector('img[src="x"]')).toBeNull();
});

test('T29/T30: legacy records have no verdict; withheld findings are explained', () => {
  const reviewer = stage('secret-blocked');
  reviewer.record.stage = 'reviewer';
  reviewer.record.verdict = 'pass';
  const legacy = stage();
  legacy.record.stage = 'implementer';
  render(<RunDetail detail={{ taskId: 'task-1', timestamp: reviewer.record.timestamp, stages: [reviewer, legacy] }} project="/repo" />);
  expect(screen.getAllByText(/^verdict:/)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /reviewer/ }));
  expect(screen.getByText('findings withheld: secret-blocked')).toBeInTheDocument();
});
