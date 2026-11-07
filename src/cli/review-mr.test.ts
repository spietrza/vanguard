import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sandbox/sandbox-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/sandbox-context.js')>()),
  startSandboxContext: vi.fn(),
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

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSandboxContext } from '../sandbox/sandbox-context.js';
import { prepareContext, runAgent } from '../core/vanguard.js';
import { mergeRequestReviewMarker, reviewMergeRequest } from '../runners/mr-review.js';
import { reviewMrCommand } from './review-mr.js';
import type { GlabRunner } from '../tasks/gitlab.js';

describe('reviewMrCommand', () => {
  const prev = { oat: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY };
  // Each test asserts on call counts, so no test may see another's calls.
  beforeEach(() => {
    vi.mocked(startSandboxContext).mockReset();
    vi.mocked(runAgent).mockReset();
  });
  afterEach(() => {
    if (prev.oat === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev.oat;
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
  });

  it('exits without starting a sandbox when the head is already reviewed', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    const sha = 'abc123def4567890';
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha });
      if (args[0] === 'api' && args[1] === 'projects/g%2Fp') return JSON.stringify({ default_branch: 'main' });
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'vanguard-bot' });
      if (args[0] === 'api') return JSON.stringify([{ system: false, author: { username: 'vanguard-bot' }, body: mergeRequestReviewMarker(sha) }]);
      return '';
    };
    const lines: string[] = [];

    await reviewMrCommand(
      { kind: 'review-mr', iid: 5, project: 'g/p', repoPath: '/repo', egress: true },
      { glab, reviewMergeRequest: (ref, deps) => reviewMergeRequest(ref, { ...deps, glab }), log: (l) => lines.push(l) },
    );

    expect(startSandboxContext).not.toHaveBeenCalled();
    expect(calls.some((c) => c[0] === 'mr' && c[1] === 'note')).toBe(false);
    expect(lines).toContain(`review-mr g/p!5: head ${sha} already reviewed -> skip`);
    expect(lines).not.toContain('review-mr g/p!5: done');
  });

  it('starts one sandbox context for both review attempts and destroys it once', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    const destroy = vi.fn(async () => undefined);
    vi.mocked(startSandboxContext).mockResolvedValue({ destroy } as never);
    const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ ...attempt, completed: false, finalText: 'Partial' })
      .mockResolvedValueOnce({ ...attempt, completed: true, finalText: 'No blocking findings.' });
    const sha = 'abc123def4567890';
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha });
      if (args[0] === 'api' && args[1] === 'projects/g%2Fp') return JSON.stringify({ default_branch: 'main' });
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'vanguard-bot' });
      if (args[0] === 'api') return '[]';
      return '';
    };

    await reviewMrCommand(
      { kind: 'review-mr', iid: 5, project: 'g/p', repoPath: '/repo', egress: true },
      { glab, reviewMergeRequest: (ref, deps) => reviewMergeRequest(ref, { ...deps, glab }), log: () => undefined },
    );

    expect(vi.mocked(runAgent).mock.calls.map(([, input]) => input.maxTurns)).toEqual([16, 24]);
    expect(startSandboxContext).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c[0] === 'mr' && c[1] === 'note')).toHaveLength(1);
  });

  it('prepares the worktree on the MR target branch as origin has it, and says so when the MR carries none (#446)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    vi.mocked(startSandboxContext).mockResolvedValue({ destroy: async () => undefined } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.mocked(prepareContext).mockClear();
      const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
      vi.mocked(runAgent).mockResolvedValue({ ...attempt, completed: true, finalText: 'No blocking findings.' });
      for (const targetBranch of ['release', undefined]) {
        const glab: GlabRunner = async (args) => {
          if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha: 'abc123def4567890', ...(targetBranch !== undefined ? { target_branch: targetBranch } : {}) });
          if (args[0] === 'api' && args[1] === 'projects/g%2Fp') return JSON.stringify({ default_branch: 'main' });
          if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'vanguard-bot' });
          if (args[0] === 'api') return '[]';
          return '';
        };
        await reviewMrCommand(
          { kind: 'review-mr', iid: 5, project: 'g/p', repoPath: '/repo', egress: true },
          { glab, reviewMergeRequest: (ref, deps) => reviewMergeRequest(ref, { ...deps, glab }), log: () => undefined },
        );
      }
      const prepared = vi.mocked(prepareContext).mock.calls.map(([opts]) => [opts.baseBranch, opts.start]);
      expect(prepared).toEqual([['release', 'base'], ['main', 'base']]);
      expect(vi.mocked(prepareContext).mock.calls[0]?.[1]?.seedWorktree).toBeTypeOf('function');
      expect(vi.mocked(prepareContext).mock.calls[1]?.[1]?.seedWorktree).toBeUndefined();
      expect(vi.mocked(runAgent).mock.calls.at(-1)?.[1].variables?.PROMPT).not.toContain('were taken from the default branch');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('MR g/p!5 carries no base branch'));
    } finally {
      warn.mockRestore();
    }
  });

  it("the default reviewer injects the --skills dir plus the base's .github/vanguard-skills, never the host checkout's", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    vi.mocked(startSandboxContext).mockResolvedValue({ destroy: async () => undefined } as never);
    // realpath: repo skill paths are resolved (macOS tmpdir is a symlink to /private/var).
    const root = await realpath(await mkdtemp(join(tmpdir(), 'vg-review-mr-skills-')));
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
      const glab: GlabRunner = async (args) => {
        if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha: 'abc123def4567890', target_branch: 'main' });
        if (args[0] === 'api' && args[1] === 'projects/g%2Fp') return JSON.stringify({ default_branch: 'main' });
        if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'vanguard-bot' });
        if (args[0] === 'api') return '[]';
        return '';
      };
      await reviewMrCommand(
        { kind: 'review-mr', iid: 5, project: 'g/p', repoPath: join(root, 'repo'), egress: true, skillsDir: join(root, 'bundled') },
        { glab, reviewMergeRequest: (ref, deps) => reviewMergeRequest(ref, { ...deps, glab }), log: () => undefined },
      );
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
      await rm(root, { recursive: true, force: true });
    }
  });

  it('--max-turns sets the first attempt cap and 1.5x for the retry', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-test';
    vi.mocked(startSandboxContext).mockResolvedValue({ destroy: async () => undefined } as never);
    const attempt = { taskId: 't', exitReason: 'completed', turns: 1, worktreePath: '/wt', worktreePreserved: false } as const;
    vi.mocked(runAgent)
      .mockResolvedValueOnce({ ...attempt, completed: false, finalText: 'Partial' })
      .mockResolvedValueOnce({ ...attempt, completed: true, finalText: 'No blocking findings.' });
    const glab: GlabRunner = async (args) => {
      if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha: 'abc123def4567890' });
      if (args[0] === 'api' && args[1] === 'projects/g%2Fp') return JSON.stringify({ default_branch: 'main' });
      if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ username: 'vanguard-bot' });
      if (args[0] === 'api') return '[]';
      return '';
    };

    await reviewMrCommand(
      { kind: 'review-mr', iid: 5, project: 'g/p', repoPath: '/repo', egress: true, maxTurns: 41 },
      { glab, reviewMergeRequest: (ref, deps) => reviewMergeRequest(ref, { ...deps, glab }), log: () => undefined },
    );

    expect(vi.mocked(runAgent).mock.calls.map(([, input]) => input.maxTurns)).toEqual([41, 62]);
  });
});

it('a failed default-branch API call posts neither a verdict nor an incomplete notice', async () => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-test');
  vi.mocked(startSandboxContext).mockResolvedValue({ destroy: async () => undefined } as never);
  const calls: string[][] = [];
  const glab: GlabRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'projects/g%2Fp') throw new Error('project API failed');
    if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 5, sha: 'abc123', target_branch: 'release' });
    return '';
  };
  try {
    await expect(reviewMrCommand({ kind: 'review-mr', iid: 5, project: 'g/p', repoPath: '/repo', egress: false }, { glab, headDedupe: false, log: () => undefined })).rejects.toThrow('Cannot establish the repository default branch');
    expect(calls.some((args) => args[1] === 'note')).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});
