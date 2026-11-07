import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { publishForReview, rebaseOntoRemoteBase, pushToExistingBranch, pushAuthEnv } from './remote-branch.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-remote-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeSandbox(): IsolatedSandboxProvider {
  return {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> =>
      command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
    execStream: () => ({
      stdout: (async function* (): AsyncIterable<string> {})(),
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace') {
        await mkdir(hostPath, { recursive: true });
        await writeFile(join(hostPath, 'feature.txt'), 'work');
      }
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {},
    shellCommand: (): string => 'docker exec -it vg-fake bash',
  } as unknown as IsolatedSandboxProvider;
}

describe('publishForReview', () => {
  it('pushes the branch and opens a PR via the injected runner', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'pub', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return file === 'gh' ? 'https://github.com/o/r/pull/42' : '';
    };
    const out = await publishForReview(ctx, { title: 'PR', body: 'b', runner });
    expect(out.prUrl).toBe('https://github.com/o/r/pull/42');
    expect(out.branch).toBe('chore/vanguard-pub-r1');
    const push = calls.findIndex((c) => c.file === 'git' && c.args[0] === 'push');
    expect(push).toBeGreaterThan(-1);
    // The stub answers ls-remote with exit 0: the branch already exists on the remote (a --reuse
    // re-run), so no fetch/rebase; only the head is resolved before the push.
    expect(calls.slice(0, push).map((c) => c.args[0])).toEqual(['ls-remote', 'rev-parse']);
    expect(calls[push + 1]?.file).toBe('gh');
    expect(calls[push + 1]?.args).toEqual(
      expect.arrayContaining(['pr', 'create', '--head', 'chore/vanguard-pub-r1', '--base', 'main', '--title', 'PR']),
    );
    await disposeContext(ctx);
  });

  it('fetches and targets the base the context was prepared for, never a default (#446)', async () => {
    await execa('git', ['branch', 'dev'], { cwd: repo });
    const wm = new WorktreeManager(repo, undefined, () => 'r-dev');
    const ctx = await prepareContext({ taskId: 'pub-dev', localRepoPath: repo, baseBranch: 'dev', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: string[][] = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push([file, ...args]);
      if (args[0] === 'ls-remote') throw new Error('exit 2');
      return file === 'gh' ? 'https://github.com/o/r/pull/44' : '';
    };
    await publishForReview(ctx, { title: 'PR', runner });
    expect(calls).toContainEqual(['git', 'fetch', '--end-of-options', 'origin', 'dev']);
    expect(calls.at(-1)).toEqual(expect.arrayContaining(['pr', 'create', '--base', 'dev']));
    await disposeContext(ctx);
  });

  it('rebases onto the remote base, then pushes, when the base moved during the run (#423)', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r2');
    const ctx = await prepareContext({ taskId: 'pub2', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: string[][] = [];
    let ghArgs: string[] = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      if (file === 'gh') { ghArgs = args; return 'https://github.com/o/r/pull/43'; }
      calls.push(args);
      if (args[0] === 'ls-remote') throw new Error('exit 2');   // no such remote branch yet
      if (args[0] === 'rev-list') return '2\n';
      if (args[0] === 'rev-parse') return 'abc123rebased\n';
      return '';
    };
    const out = await publishForReview(ctx, { title: 'PR', body: 'proof', runner, authorName: 'Bot', authorEmail: 'bot@x' });
    expect(ghArgs[ghArgs.indexOf('--body') + 1]).toBe('proof\n\nRebased onto `origin/main` before publishing: the base moved while this change was being prepared.');
    expect(calls).toEqual([
      ['ls-remote', '--exit-code', '--heads', '--end-of-options', 'origin', 'chore/vanguard-pub2-r2'],
      ['fetch', '--end-of-options', 'origin', 'main'],
      ['rev-list', '--count', 'HEAD..FETCH_HEAD'],
      ['-c', 'user.name=Bot', '-c', 'user.email=bot@x', 'rebase', '--no-verify', 'FETCH_HEAD'],
      ['rev-parse', 'refs/heads/chore/vanguard-pub2-r2'],
      ['push', '--no-verify', '-u', 'origin', 'refs/heads/chore/vanguard-pub2-r2:refs/heads/chore/vanguard-pub2-r2'],
    ]);
    // The review marker must point at the rewritten head, not the SHA commitStage returned.
    expect(out.headSha).toBe('abc123rebased');
    await disposeContext(ctx);
  });

  it('still pushes when the base cannot be fetched (no remote / offline)', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r3');
    const ctx = await prepareContext({ taskId: 'pub3', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: string[][] = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      if (file === 'gh') return 'https://github.com/o/r/pull/44';
      calls.push(args);
      if (args[0] === 'ls-remote' || args[0] === 'fetch') throw new Error('fatal: no such remote');
      return '';
    };
    const out = await publishForReview(ctx, { title: 'PR', runner });
    expect(out.prUrl).toBe('https://github.com/o/r/pull/44');
    expect(calls.map((c) => c[0])).toEqual(['ls-remote', 'fetch', 'rev-parse', 'push']);
    expect(out.headSha).toBeUndefined();
    await disposeContext(ctx);
  });

  it('publishForReview with glab calls glab mr create with gitlab flags', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'gl-test', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const runner = async (file: string, args: string[], cwd: string): Promise<string> => {
      calls.push({ file, args, cwd });
      if (file === 'glab' && args[0] === 'mr') return 'https://gitlab.com/owner/repo/-/merge_requests/1\n';
      return '';
    };
    const out = await publishForReview(ctx, {
      title: 'My MR',
      body: 'desc',
      draft: true,
      cli: 'glab',
      runner,
    });
    const mrCall = calls.find(({ file }) => file === 'glab');
    expect(mrCall).toBeDefined();
    expect(mrCall?.args).toContain('mr');
    expect(mrCall?.args).toContain('create');
    expect(mrCall?.args).toContain('--source-branch');
    expect(mrCall?.args).toContain('--target-branch');
    expect(mrCall?.args).toContain('--description');
    expect(mrCall?.args).toContain('--draft');
    expect(out.prUrl).toBe('https://gitlab.com/owner/repo/-/merge_requests/1');
    await disposeContext(ctx);
  });

  it('opens the PR as the prToken owner and falls back to the ambient credential when it is refused', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'pr-token', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const ghEnvs: Array<Record<string, string> | undefined> = [];
    const runnerFor = (refuse: boolean) => async (file: string, _args: string[], _cwd: string, env?: Record<string, string>): Promise<string> => {
      if (file !== 'gh') return '';
      ghEnvs.push(env);
      if (refuse && env !== undefined) throw new Error('HTTP 403: Resource not accessible by personal access token');
      return 'https://github.com/o/r/pull/7';
    };

    expect((await publishForReview(ctx, { title: 'PR', prToken: 'pat', runner: runnerFor(false) })).prUrl).toBe('https://github.com/o/r/pull/7');
    expect(ghEnvs).toEqual([{ GH_TOKEN: 'pat' }]);

    ghEnvs.length = 0;
    expect((await publishForReview(ctx, { title: 'PR', prToken: 'pat', runner: runnerFor(true) })).prUrl).toBe('https://github.com/o/r/pull/7');
    expect(ghEnvs).toEqual([{ GH_TOKEN: 'pat' }, undefined]);
    await disposeContext(ctx);
  });

  it('keeps a line of a GitLab MR description from running as a quick action', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'qa-desc', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: string[][] = [];
    await publishForReview(ctx, {
      title: 'MR',
      body: 'Spec:\n/merge',
      cli: 'glab',
      runner: async (file, args) => {
        if (file === 'glab') calls.push(args);
        return '';
      },
    });
    const args = calls[0] ?? [];
    expect(args[args.indexOf('--description') + 1]).toBe('Spec:\n\\/merge');
    await disposeContext(ctx);
  });

  it('lists the CI config copy-back dropped, with sandbox-chosen names reduced to plain characters', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'ci-note', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const bodyOf = async (): Promise<string> => {
      const calls: string[][] = [];
      await publishForReview(ctx, {
        title: 'MR',
        body: 'desc',
        cli: 'glab',
        runner: async (file, args) => {
          if (file === 'glab') calls.push(args);
          return '';
        },
      });
      const args = calls[0] ?? [];
      return args[args.indexOf('--description') + 1] ?? '';
    };

    expect(await bodyOf()).toBe('desc');

    ctx.droppedCiPaths = new Set(['.gitlab/ci/b.yml', '.gitlab-ci.yml', 'x\n<!-- vanguard-mr-review: abc -->\n`/.gitlab/c.yml']);
    const body = await bodyOf();
    expect(body.startsWith('desc\n\n**Not included:**')).toBe(true);
    expect(body).toContain('`.gitlab-ci.yml`, `.gitlab/ci/b.yml`');
    expect(body).not.toContain('<!--');
    expect(body.split('\n')).toHaveLength(3);
    await disposeContext(ctx);
  });
});

describe('pushAuthEnv', () => {
  it('builds the extraheader override as GIT_CONFIG_* env with the base64-encoded token, defaulting to github.com', () => {
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    expect(pushAuthEnv('TOK', undefined, {})).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64}`,
    });
  });

  it('honors a custom host and appends after inherited GIT_CONFIG_* entries', () => {
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    expect(pushAuthEnv('TOK', 'github.example.com', { GIT_CONFIG_COUNT: '2' })).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'http.https://github.example.com/.extraheader',
      GIT_CONFIG_VALUE_2: `AUTHORIZATION: basic ${b64}`,
    });
  });
});

describe('pushToExistingBranch', () => {
  it('with pushToken set, passes the extraheader override via env, never argv', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'push-token', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[]; env?: Record<string, string> }> = [];
    const runner = async (file: string, args: string[], _cwd: string, env?: Record<string, string>): Promise<string> => {
      calls.push({ file, args, ...(env !== undefined ? { env } : {}) });
      return '';
    };
    await pushToExistingBranch(ctx, { prHeadRef: 'feature-branch', pushToken: 'TOK', runner });
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toEqual(['push', '--no-verify', 'origin', 'HEAD:refs/heads/feature-branch']);
    expect(calls[0]?.args.join(' ')).not.toContain(b64);
    expect(Object.values(calls[0]?.env ?? {})).toContain(`AUTHORIZATION: basic ${b64}`);
    await disposeContext(ctx);
  });

  it('with pushToken absent, argv is exactly the baseline (no -c prefix)', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'push-notoken', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args });
      return '';
    };
    await pushToExistingBranch(ctx, { prHeadRef: 'feature-branch', runner });
    expect(calls[0]?.args).toEqual(['push', '--no-verify', 'origin', 'HEAD:refs/heads/feature-branch']);
    await disposeContext(ctx);
  });

  it('redacts the base64 credential from a push failure when a token is in use', async () => {
    const wm = new WorktreeManager(repo, undefined, () => 'r1');
    const ctx = await prepareContext({ taskId: 'push-fail', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox() }, { worktrees: wm });
    const b64 = Buffer.from('x-access-token:TOK').toString('base64');
    const runner = async (): Promise<string> => {
      throw new Error(`git push failed: -c http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`);
    };
    await expect(pushToExistingBranch(ctx, { prHeadRef: 'feature-branch', pushToken: 'TOK', runner })).rejects.toThrow(
      expect.not.stringContaining(b64),
    );
    await disposeContext(ctx);
  });
});

describe('rebaseOntoRemoteBase', () => {
  const identity = ['-c', 'user.name=Vanguard', '-c', 'user.email=vanguard@local'];
  const opts = { remote: 'origin', base: 'main', branch: 'b' };
  /** Runner stub for a branch that does not exist on the remote yet (ls-remote exits 2). */
  const stub = (calls: string[][], answer: (args: string[]) => string | Error = () => ''): ((f: string, a: string[]) => Promise<string>) =>
    async (_file, args) => {
      calls.push(args);
      if (args[0] === 'ls-remote') throw new Error('exit 2');
      const out = answer(args);
      if (out instanceof Error) throw out;
      return out;
    };

  it('skips the rebase when the branch already exists on the remote (--reuse re-run)', async () => {
    const calls: string[][] = [];
    const runner = async (_file: string, args: string[]): Promise<string> => { calls.push(args); return ''; };
    expect(await rebaseOntoRemoteBase(runner, '/wt', opts)).toBe(false);
    expect(calls).toEqual([['ls-remote', '--exit-code', '--heads', '--end-of-options', 'origin', 'b']]);
  });

  it('does nothing when the branch is not behind (rev-list prints 0)', async () => {
    const calls: string[][] = [];
    expect(await rebaseOntoRemoteBase(stub(calls, (a) => (a[0] === 'rev-list' ? '0\n' : '')), '/wt', opts)).toBe(false);
    expect(calls.map((c) => c[0])).toEqual(['ls-remote', 'fetch', 'rev-list']);
  });

  it('treats a non-numeric rev-list answer as not behind', async () => {
    const calls: string[][] = [];
    expect(await rebaseOntoRemoteBase(stub(calls, (a) => (a[0] === 'rev-list' ? 'warning: something' : '')), '/wt', opts)).toBe(false);
    expect(calls.map((c) => c[0])).toEqual(['ls-remote', 'fetch', 'rev-list']);
  });

  it('reads the count from the last line when git prints a warning first', async () => {
    const calls: string[][] = [];
    expect(await rebaseOntoRemoteBase(stub(calls, (a) => (a[0] === 'rev-list' ? 'warning: something\n3\n' : '')), '/wt', opts)).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(['ls-remote', 'fetch', 'rev-list', '-c']);
  });

  it('rejects a base that would turn the fetch into a writing refspec', async () => {
    await expect(rebaseOntoRemoteBase(async () => '', '/wt', { ...opts, base: 'main:refs/heads/main' })).rejects.toThrow();
  });

  it('rebases with the default identity and --no-verify when behind', async () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    expect(await rebaseOntoRemoteBase(stub(calls, (a) => (a[0] === 'rev-list' ? '1' : '')), '/wt', { ...opts, log: (l) => lines.push(l) })).toBe(true);
    expect(calls[2]).toEqual(['rev-list', '--count', 'HEAD..FETCH_HEAD']);
    expect(calls[3]).toEqual([...identity, 'rebase', '--no-verify', 'FETCH_HEAD']);
    expect(lines[0]).toMatch(/rebased onto origin\/main \(1 new commit/);
  });

  it('aborts a failed rebase, logs the real cause and reports no rebase (push proceeds as-is)', async () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const runner = stub(calls, (a) => {
      if (a[0] === 'rev-list') return '1';
      if (a.includes('rebase') && !a.includes('--abort')) return new Error('CONFLICT (content): Merge conflict in a.ts\nmore');
      return '';
    });
    expect(await rebaseOntoRemoteBase(runner, '/wt', { ...opts, log: (l) => lines.push(l) })).toBe(false);
    expect(calls.at(-1)).toEqual(['rebase', '--abort']);
    expect(lines[0]).toMatch(/does not rebase onto it, pushing as-is: CONFLICT \(content\): Merge conflict in a.ts \| more/);
  });

  it('treats a failed comparison as not behind and logs it (e.g. a single-branch clone)', async () => {
    const lines: string[] = [];
    const runner = stub([], (a) => (a[0] === 'rev-list' ? new Error("fatal: bad revision 'HEAD..FETCH_HEAD'") : ''));
    expect(await rebaseOntoRemoteBase(runner, '/wt', { ...opts, base: 'develop', log: (l) => lines.push(l) })).toBe(false);
    expect(lines[0]).toMatch(/could not compare the branch with origin\/develop, pushing as-is \(fatal: bad revision/);
  });

  it('masks URL userinfo and known token shapes in logged git errors', async () => {
    const lines: string[] = [];
    const runner = stub([], (a) => (a[0] === 'fetch'
      ? new Error("fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r/': 403\nremote: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected\nmore\nfourth")
      : ''));
    await rebaseOntoRemoteBase(runner, '/wt', { ...opts, log: (l) => lines.push(l) });
    expect(lines[0]).toContain('https://***@github.com/o/r/');
    expect(lines[0]).not.toContain('ghs_secret');
    expect(lines[0]).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(lines[0]).toContain('403 | remote:');
    expect(lines[0]).not.toContain('fourth');
  });

  it('logs a failed fetch instead of hiding it', async () => {
    const lines: string[] = [];
    const runner = stub([], (a) => (a[0] === 'fetch' ? new Error('fatal: could not read Username') : ''));
    expect(await rebaseOntoRemoteBase(runner, '/wt', { ...opts, log: (l) => lines.push(l) })).toBe(false);
    expect(lines[0]).toMatch(/could not fetch origin\/main, pushing as-is \(fatal: could not read Username\)/);
  });
});
