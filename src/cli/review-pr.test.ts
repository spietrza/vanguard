import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../sandbox/sandbox-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/sandbox-context.js')>()),
  startSandboxContext: vi.fn(async () => ({ destroy: async () => undefined })),
}));
vi.mock('../sandbox/llm-proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/llm-proxy.js')>()),
  startProviderProxies: vi.fn(async () => ({ destroy: async () => undefined })),
}));
vi.mock('../core/vanguard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/vanguard.js')>()),
  prepareContext: vi.fn(async () => ({})),
  runAgent: vi.fn(),
  disposeContext: vi.fn(async () => undefined),
}));

import { prepareContext, runAgent } from '../core/vanguard.js';
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewPrCommand } from './review-pr.js';
import { PullRequestReviewIncompleteError, reviewPullRequest } from '../runners/pr-review.js';
import type { GhRunner } from '../tasks/github.js';
import type { Command } from './args.js';
import type { ReviewPullRequestDeps, ReviewPullRequestResult } from '../runners/pr-review.js';

function fakeResult(): ReviewPullRequestResult {
  return {
    pr: {
      repoSlug: 'o/r',
      number: 12,
      title: 'Fix auth',
      body: '',
      url: 'https://github.com/o/r/pull/12',
      author: 'alice',
      headRefName: 'h',
      headRefOid: 'abc123',
      baseRefName: 'main',
      isCrossRepository: false,
      headRepositoryOwner: '',
      diff: 'diff',
      labels: [],
    },
    commentBody: '## Vanguard Review\n\nNo blocking findings.',
  };
}

describe('reviewPrCommand', () => {
  // The cap tests assert on runAgent's calls, so no test may see another's.
  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
  });

  it.each(['Risk: high — authentication can fail.', ''])('carries optional risk through the runner into the job summary: %s', async (riskLine) => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-review-summary-'));
    const summaryPath = join(dir, 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryPath);
    try {
      const gh: GhRunner = async (args) => {
        if (args[1] === 'view') return JSON.stringify({ number: 12, headRefOid: 'abc123' });
        return '';
      };
      await reviewPrCommand(
        { kind: 'review-pr', prRef: 'o/r#12', repoPath: '/repo', egress: false },
        {
          reviewer: async () => ({ text: `Verdict: NO BLOCKING FINDINGS\n${riskLine}`, completed: true }),
          reviewPullRequest: (ref, deps) => reviewPullRequest(ref, { ...deps, gh }),
          log: () => undefined,
        },
      );
      const summary = await readFile(summaryPath, 'utf8');
      expect(summary).toContain('- Verdict: clean');
      if (riskLine) expect(summary).toContain('- Verdict: clean\n- Risk: high');
      else expect(summary).not.toContain('- Risk:');
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delegates to the PR review runner and preserves operator logs', async () => {
    const logs: string[] = [];
    const reviewer = vi.fn().mockResolvedValue({ text: 'No blocking findings.', completed: true });
    const reviewPullRequest = vi.fn(
      async (_ref: string, deps: ReviewPullRequestDeps): Promise<ReviewPullRequestResult> => {
        deps.log?.('review-pr o/r#12: fetch -> diff');
        deps.log?.('review-pr o/r#12: posted -> pr review');
        return fakeResult();
      },
    );
    const cmd: Extract<Command, { kind: 'review-pr' }> = {
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/repo',
      egress: false,
      provider: 'codex',
      reviewModel: 'gpt-5',
    };

    await reviewPrCommand(cmd, {
      reviewer,
      reviewPullRequest,
      log: (line) => logs.push(line),
    });

    expect(reviewPullRequest).toHaveBeenCalledWith(
      '12',
      expect.objectContaining({
        repoSlug: 'o/r',
        reviewer,
        log: expect.any(Function),
      }),
    );
    expect(logs).toEqual([
      'review-pr o/r#12: fetch -> diff',
      'review-pr o/r#12: posted -> pr review',
      'review-pr o/r#12: done',
    ]);
  });

  it('the default reviewer prepares the worktree on the PR base as origin has it, and says so when the PR carries none (#446)', async () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(prepareContext).mockClear();
      const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
      vi.mocked(runAgent).mockResolvedValue({ ...attempt, completed: true, finalText: 'No blocking findings.' });
      const cmd: Extract<Command, { kind: 'review-pr' }> = { kind: 'review-pr', prRef: '12', repoSlug: 'o/r', repoPath: '/repo', egress: false };
      // The injected runner hands the default reviewer a PR against `release`, then one with no base at all.
      for (const baseRefName of ['release', '']) {
        await reviewPrCommand(cmd, {
          gh: async () => JSON.stringify({ defaultBranchRef: { name: 'main' } }),
          reviewPullRequest: async (_ref, deps) => {
            await deps.reviewer({ ...fakeResult().pr, baseRefName }, { isRetry: false });
            return fakeResult();
          },
          log: () => undefined,
        });
      }
      const prepared = vi.mocked(prepareContext).mock.calls.map(([opts]) => [opts.baseBranch, opts.start]);
      expect(prepared).toEqual([['release', 'base'], ['main', 'base']]);
      expect(vi.mocked(prepareContext).mock.calls[0]?.[1]?.seedWorktree).toBeTypeOf('function');
      expect(vi.mocked(prepareContext).mock.calls[1]?.[1]?.seedWorktree).toBeUndefined();
      expect(vi.mocked(runAgent).mock.calls.at(-1)?.[1].variables?.PROMPT).not.toContain('were taken from the default branch');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('PR o/r#12 carries no base branch'));
    } finally {
      warn.mockRestore();
      if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    }
  });

  it("the default reviewer injects the --skills dir plus the base's .github/vanguard-skills, never the host checkout's", async () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    // realpath: repo skill paths are resolved (macOS tmpdir is a symlink to /private/var).
    const root = await realpath(await mkdtemp(join(tmpdir(), 'vg-review-pr-skills-')));
    try {
      // The host checkout holds the change under review (a code-review override); the worktree holds the base.
      const skillDirs = [
        join(root, 'bundled', 'code-review'),
        join(root, 'repo', '.github', 'vanguard-skills', 'code-review'),
        join(root, 'worktree', '.github', 'vanguard-skills', 'deploy'),
      ];
      for (const dir of skillDirs) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'SKILL.md'), '---\nname: s\ndescription: d\n---\n');
      }
      vi.mocked(prepareContext).mockClear();
      const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
      vi.mocked(runAgent).mockResolvedValue({ ...attempt, completed: true, finalText: 'No blocking findings.' });
      const cmd: Extract<Command, { kind: 'review-pr' }> = {
        kind: 'review-pr',
        prRef: '12',
        repoSlug: 'o/r',
        repoPath: join(root, 'repo'),
        egress: false,
        skillsDir: join(root, 'bundled'),
      };
      await reviewPrCommand(cmd, {
        gh: async () => JSON.stringify({ defaultBranchRef: { name: 'main' } }),
        reviewPullRequest: async (_ref, deps) => {
          await deps.reviewer(fakeResult().pr, { isRetry: false });
          return fakeResult();
        },
        log: () => undefined,
      });
      // prepareContext gets a resolver: repo skills are read from the worktree it cuts, not the host checkout.
      const resolve = vi.mocked(prepareContext).mock.calls[0]?.[1]?.skills;
      if (typeof resolve !== 'function') throw new Error('expected a worktree skill resolver');
      const copied: string[][] = [];
      await (await resolve(join(root, 'worktree'))).inject(['code-review', 'deploy'], { copyIn: async (from: string, to: string) => { copied.push([from, to]); } } as never);
      expect(copied).toEqual([
        [join(root, 'bundled', 'code-review'), '/workspace/.vanguard/skills/code-review'],
        [join(root, 'worktree', '.github', 'vanguard-skills', 'deploy'), '/workspace/.vanguard/skills/deploy'],
      ]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('--out writes the review to a file and tells the runner not to publish (no PR comment)', async () => {
    const outPath = join(tmpdir(), `vanguard-review-out-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
    let seenPublish: boolean | undefined;
    const reviewPullRequest = vi.fn(async (_ref: string, deps: ReviewPullRequestDeps): Promise<ReviewPullRequestResult> => {
      seenPublish = deps.publish;
      return fakeResult();
    });
    const cmd: Extract<Command, { kind: 'review-pr' }> = {
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/repo',
      egress: false,
      out: outPath,
    };
    try {
      await reviewPrCommand(cmd, { reviewer: vi.fn(), reviewPullRequest, log: () => {} });
      expect(seenPublish).toBe(false);
      expect(await readFile(outPath, 'utf8')).toBe('## Vanguard Review\n\nNo blocking findings.');
    } finally {
      await rm(outPath, { force: true });
    }
  });

  it('--out writes the incomplete notice and rethrows so the exit code stays truthful', async () => {
    const outPath = join(tmpdir(), `vanguard-review-out-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
    const incomplete = new PullRequestReviewIncompleteError(fakeResult().pr, '## Vanguard Review\n\nnotice');
    const reviewPullRequest = vi.fn(async (): Promise<ReviewPullRequestResult> => {
      throw incomplete;
    });
    const cmd: Extract<Command, { kind: 'review-pr' }> = {
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/repo',
      egress: false,
      out: outPath,
    };
    try {
      await expect(reviewPrCommand(cmd, { reviewer: vi.fn(), reviewPullRequest, log: () => {} })).rejects.toBe(incomplete);
      expect(await readFile(outPath, 'utf8')).toBe('## Vanguard Review\n\nnotice');
    } finally {
      await rm(outPath, { force: true });
    }
  });

  it.each([
    { maxTurns: undefined, caps: [16, 24] },
    { maxTurns: 41, caps: [41, 62] },
    { maxTurns: Number.MAX_SAFE_INTEGER, caps: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] },
  ])('--max-turns $maxTurns gives caps $caps for the first attempt and the retry', async ({ maxTurns, caps }) => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-test');
    try {
      const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
      vi.mocked(runAgent)
        .mockResolvedValueOnce({ ...attempt, completed: false, finalText: 'Partial' })
        .mockResolvedValueOnce({ ...attempt, completed: true, finalText: 'No blocking findings.' });
      const gh: GhRunner = async (args) => {
        if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' } });
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 12, headRefOid: 'abc123' });
        return '';
      };

      await reviewPrCommand(
        { kind: 'review-pr', prRef: 'o/r#12', repoPath: '/repo', egress: true, ...(maxTurns !== undefined ? { maxTurns } : {}) },
        { gh, reviewPullRequest: (ref, deps) => reviewPullRequest(ref, { ...deps, gh }), log: () => undefined },
      );

      expect(vi.mocked(runAgent).mock.calls.map(([, input]) => input.maxTurns)).toEqual(caps);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it('seeds real default-branch skills before resolving the review registry and discloses their source', async () => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-test');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vg-review-overlay-')));
  const repoPath = join(root, 'repo');
  const worktreePath = join(root, 'wt');
  const git = (args: string[]) => execa('git', args, { cwd: repoPath });
  try {
    await mkdir(repoPath);
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.name', 'test']);
    await git(['config', 'user.email', 'test@local']);
    const trusted = join(repoPath, '.github/vanguard-skills/trusted-review');
    await mkdir(trusted, { recursive: true });
    await writeFile(join(trusted, 'SKILL.md'), '---\nname: trusted-review\ndescription: trusted\n---\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'trusted']);
    await git(['checkout', '-qb', 'release']);
    await git(['rm', '-qr', '.github']);
    const evil = join(repoPath, '.github/vanguard-skills/base-only');
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, 'SKILL.md'), '---\nname: base-only\ndescription: evil\n---\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'base']);
    await git(['worktree', 'add', '-qb', 'review', worktreePath]);
    vi.mocked(prepareContext).mockImplementationOnce(async (_opts, deps) => {
      await deps?.seedWorktree?.(worktreePath);
      if (typeof deps?.skills !== 'function') throw new Error('expected skill resolver');
      const registry = await deps.skills(worktreePath);
      const copyIn = vi.fn(async () => undefined);
      await registry.inject(['trusted-review'], { copyIn } as never);
      expect(copyIn).toHaveBeenCalledWith(join(worktreePath, '.github/vanguard-skills/trusted-review'), '/workspace/.vanguard/skills/trusted-review');
      await expect(registry.inject(['base-only'], { copyIn } as never)).rejects.toThrow('Unknown skill');
      return {} as never;
    });
    vi.mocked(runAgent).mockResolvedValue({ completed: true, finalText: 'No blocking findings.' } as never);
    await reviewPrCommand({ kind: 'review-pr', prRef: '12', repoPath, egress: false }, {
      gh: async () => JSON.stringify({ defaultBranchRef: { name: 'main' } }),
      reviewPullRequest: async (_ref, deps) => {
        await deps.reviewer({ ...fakeResult().pr, baseRefName: 'release' }, { isRetry: false });
        return fakeResult();
      },
      log: () => undefined,
    });
    expect(vi.mocked(runAgent).mock.calls.at(-1)?.[1].variables?.PROMPT).toContain('were taken from the default branch main');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('a failed default-branch API call posts neither a verdict nor an incomplete notice', async () => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-test');
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'repo') throw new Error('repo view failed');
    if (args[1] === 'view') return JSON.stringify({ number: 12, baseRefName: 'release' });
    return '';
  };
  try {
    await expect(reviewPrCommand({ kind: 'review-pr', prRef: 'o/r#12', repoPath: '/repo', egress: false }, { gh, log: () => undefined })).rejects.toThrow('Cannot establish the repository default branch');
    expect(calls.some((args) => args[1] === 'review' || args[1] === 'comment')).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});
