import { describe, it, expect, vi } from 'vitest';
import { revisePrCommand } from './revise-pr.js';
import type { Command } from './args.js';
import type { ReviseGithubPrDeps, ReviseGithubPrResult } from '../runners/revise-pr.js';

function makeCmd(overrides: Partial<Extract<Command, { kind: 'revise-pr' }>> = {}): Extract<Command, { kind: 'revise-pr' }> {
  return {
    kind: 'revise-pr',
    prRef: '7',
    repoSlug: 'o/r',
    repoPath: '/repo',
    egress: false,
    ...overrides,
  };
}

function makeResult(committed = true): ReviseGithubPrResult {
  return {
    pr: {
      repoSlug: 'o/r',
      number: 7,
      title: 'Fix auth',
      body: '',
      url: 'https://github.com/o/r/pull/7',
      author: 'SebaBoler',
      headRefName: 'feature-branch',
      headRefOid: 'deadbeef',
      baseRefName: 'main',
      isCrossRepository: false,
      headRepositoryOwner: '',
      diff: 'diff',
    },
    addressed: committed ? 1 : 0,
    committed,
    pushed: committed,
    undrafted: committed,
  };
}

describe('revisePrCommand', () => {
  it('rejects fallback transport collisions before invoking the runner', async () => {
    const revisePullRequest = vi.fn(async (): Promise<ReviseGithubPrResult> => makeResult());
    await expect(revisePrCommand(makeCmd({ provider: 'claude', fallbackProvider: 'zai' }), { revisePullRequest })).rejects.toThrow(/transport/);
    expect(revisePullRequest).not.toHaveBeenCalled();
  });

  it('forwards the fallback provider and model to the runner', async () => {
    const revisePullRequest = vi.fn(async (): Promise<ReviseGithubPrResult> => makeResult());
    await revisePrCommand(makeCmd({ provider: 'claude', fallbackProvider: 'codex', fallbackModel: 'gpt-5' }), { revisePullRequest });
    expect(revisePullRequest).toHaveBeenCalledWith('7', expect.objectContaining({ fallbackProvider: 'codex', fallbackModel: 'gpt-5' }));
  });

  it('delegates to the revision runner and logs the done message on success', async () => {
    const logs: string[] = [];
    const revisePullRequest = vi.fn(
      async (_ref: string, _deps: ReviseGithubPrDeps): Promise<ReviseGithubPrResult> => {
        return makeResult(true);
      },
    );

    await revisePrCommand(makeCmd(), {
      revisePullRequest,
      log: (line) => logs.push(line),
    });

    expect(revisePullRequest).toHaveBeenCalledWith('7', expect.objectContaining({ repoSlug: 'o/r', repoPath: '/repo' }));
    expect(logs.some((l) => l.includes('done'))).toBe(true);
    expect(logs.some((l) => l.includes('o/r#7'))).toBe(true);
  });

  it('logs a no-changes message when nothing was committed', async () => {
    const logs: string[] = [];
    const revisePullRequest = vi.fn(async (): Promise<ReviseGithubPrResult> => makeResult(false));

    await revisePrCommand(makeCmd(), {
      revisePullRequest,
      log: (line) => logs.push(line),
    });

    expect(logs.some((l) => l.includes('no changes'))).toBe(true);
  });

  it('logs a BLOCKED line (not the done/no-changes/dry-run lines) when the revision carried a secret', async () => {
    // The runner never returns secretBlocked together with dryRunOut; both are set here only to pin that BLOCKED wins.
    const logs: string[] = [];
    const revisePullRequest = vi.fn(async (): Promise<ReviseGithubPrResult> => ({ ...makeResult(false), addressed: 2, secretBlocked: true, dryRunOut: '/tmp/x.md' }));
    await revisePrCommand(makeCmd(), { revisePullRequest, log: (line) => logs.push(line) });
    expect(logs.some((l) => /BLOCKED .*secret.*nothing pushed \(2 item\(s\) abandoned\)/.test(l))).toBe(true);
    expect(logs.some((l) => l.includes('no changes') || l.includes('dry-run written'))).toBe(false);
  });

  it('passes prRef from --github-pr via cmd.prRef', async () => {
    const revisePullRequest = vi.fn(async (): Promise<ReviseGithubPrResult> => makeResult());
    await revisePrCommand(makeCmd({ prRef: 'https://github.com/o/r/pull/42' }), { revisePullRequest });
    expect(revisePullRequest).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/42',
      expect.objectContaining({ repoSlug: 'o/r' }),
    );
  });

  it('forwards maxRounds to the runner when provided', async () => {
    const revisePullRequest = vi.fn(async (): Promise<ReviseGithubPrResult> => makeResult());
    await revisePrCommand(makeCmd({ maxRounds: 3 }), { revisePullRequest });
    expect(revisePullRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxRounds: 3 }),
    );
  });

  it('T27: forwards feedback authors and leaves the ignored-author lines to the runner', async () => {
    const logs: string[] = [];
    const revisePullRequest = vi.fn(async () => ({ ...makeResult(false), ignoredFeedback: [
      { author: 'mallory', association: 'NONE' }, { author: 'outsider', association: '' },
    ] }));
    await revisePrCommand(makeCmd({ feedbackAuthors: ['Alice'] }), { revisePullRequest, log: (line) => logs.push(line) });
    expect(revisePullRequest).toHaveBeenCalledWith('7', expect.objectContaining({ feedbackAuthors: ['Alice'] }));
    // The runner already logs these through the same `log`; re-printing here duplicated every line.
    expect(logs.filter((l) => l.includes('ignored feedback'))).toEqual([]);
  });
});
