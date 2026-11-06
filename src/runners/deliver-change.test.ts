import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { prepareContext, disposeContext } from '../core/vanguard.js';
import { WorktreeManager } from '../worktree/manager.js';
import { conventionalPrTitle, deliverChange, scanOutgoingForSecrets } from './deliver-change.js';
import { renderSecretBlockComment } from '../core/secret-scan.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-deliver-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** A sandbox whose copy-out writes `content` into feature.txt (undefined = the agent changed nothing). */
function makeSandbox(content?: string): IsolatedSandboxProvider {
  return {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> =>
      command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
    execStream: () => ({ stdout: (async function* (): AsyncIterable<string> {})(), result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace' && content !== undefined) {
        await mkdir(hostPath, { recursive: true });
        await writeFile(join(hostPath, 'feature.txt'), content);
      }
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {},
  } as unknown as IsolatedSandboxProvider;
}

async function withWork(content: string | undefined, run: (ctx: Awaited<ReturnType<typeof prepareContext>>) => Promise<void>): Promise<void> {
  const ctx = await prepareContext({ taskId: 'dc', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox(content) }, { worktrees: new WorktreeManager(repo) });
  try {
    // Simulate the stage sync: write what the sandbox "produced" into the worktree.
    if (content !== undefined) await writeFile(join(ctx.worktreePath, 'feature.txt'), content);
    await run(ctx);
  } finally {
    await disposeContext(ctx);
  }
}

describe('deliverChange', () => {
  it('blocks on a secret in the outgoing diff before anything is committed or pushed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[][] = [];
    try {
      await withWork('token = "ghp_' + 'A'.repeat(40) + '"', async (ctx) => {
        const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: ctx.worktreePath })).stdout;
        const r = await deliverChange(ctx, {
          taskId: 'T-1',
          commitMessage: 'feat: x',
          target: { kind: 'existing-branch', prHeadRef: 'pr-head', runner: async (_f, a) => { calls.push(a); return ''; } },
        });
        expect(r.kind).toBe('secret-blocked');
        expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: ctx.worktreePath })).stdout).toBe(before); // no commit
      });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual([]);
  });

  describe('a file the worktree .gitattributes renders as binary', () => {
    const credential = 'opaque-credential-92837';
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ['no attributes (control)', undefined],
      ['`-diff`', 'config.ts -diff\n'],
      ['a `binary` glob', '*.ts binary\n'],
      ['textconv to nothing', '*.ts diff=hide\n'],
    ])('blocks an injected credential on a later line: %s', async (_label, attributes) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubEnv('OPENAI_API_KEY', credential);
      const calls: string[][] = [];
      try {
        await withWork('work', async (ctx) => {
          if (attributes !== undefined) await writeFile(join(ctx.worktreePath, '.gitattributes'), attributes);
          await execa('git', ['config', 'diff.hide.textconv', 'true'], { cwd: ctx.worktreePath });
          await writeFile(join(ctx.worktreePath, 'config.ts'), `// config\nexport const k = "${credential}";\n`);
          // The plain rendering really does hide it under an attribute: the gate must not rely on it.
          if (attributes !== undefined) expect(await ctx.wm.diff(ctx.worktreePath)).not.toContain(credential);
          const r = await deliverChange(ctx, {
            taskId: 'T-1',
            commitMessage: 'feat: x',
            target: { kind: 'existing-branch', prHeadRef: 'pr-head', runner: async (_f, a) => { calls.push(a); return ''; } },
          });
          expect(r.kind).toBe('secret-blocked');
          if (r.kind !== 'secret-blocked' || r.block.reason !== 'findings') throw new Error('expected a findings block');
          expect(r.block.injected).toEqual([{ file: 'config.ts', line: 2 }]);
        });
      } finally {
        spy.mockRestore();
      }
      expect(calls).toEqual([]);
    });
  });

  it('reports no-changes when the worktree is clean and pushes nothing', async () => {
    const calls: string[][] = [];
    await withWork(undefined, async (ctx) => {
      const r = await deliverChange(ctx, {
        taskId: 'T-1',
        commitMessage: 'feat: x',
        target: { kind: 'existing-branch', prHeadRef: 'pr-head', runner: async (_f, a) => { calls.push(a); return ''; } },
      });
      expect(r.kind).toBe('no-changes');
    });
    expect(calls).toEqual([]);
  });

  it('existing-branch: commits with the given identity and pushes HEAD onto the PR head', async () => {
    const calls: string[][] = [];
    await withWork('work', async (ctx) => {
      const r = await deliverChange(ctx, {
        taskId: 'T-1',
        commitMessage: 'fix: address review feedback',
        commitAuthor: { name: 'Acme Bot', email: 'bot@acme.test' },
        target: { kind: 'existing-branch', prHeadRef: 'pr-head', runner: async (_f, a) => { calls.push(a); return ''; } },
      });
      expect(r.kind).toBe('delivered-push');
      if (r.kind !== 'delivered-push') return;
      expect(r.headSha).toBe(r.sha);
      const log = (await execa('git', ['log', '-1', '--format=%an <%ae> %s'], { cwd: ctx.worktreePath })).stdout;
      expect(log).toBe('Acme Bot <bot@acme.test> fix: address review feedback');
    });
    expect(calls.some((a) => a[0] === 'push' && a.includes('HEAD:pr-head'))).toBe(true);
  });

  it('new-pr: builds the body after the commit with the closing-keyword leaks, pushes, opens the PR and reports the pushed head', async () => {
    const calls: string[][] = [];
    await withWork('work', async (ctx) => {
      const r = await deliverChange(ctx, {
        taskId: 'o/r#7',
        commitMessage: 'feat: thing\n\nCloses #7',
        closingKeywordScan: true,
        target: {
          kind: 'new-pr',
          title: 'thing (o/r#7)',
          draft: true,
          body: ({ commitLeaks }) => `Part of #7\n\nleaks=${commitLeaks.length}`,
          runner: async (file, a) => {
            calls.push([file, ...a]);
            if (file === 'gh') return 'https://github.com/o/r/pull/9';
            // Only the branch-head read after the push rebase reports the rewritten commit.
            if (a[0] === 'rev-parse' && String(a[1]).startsWith('refs/heads/')) return 'rebasedhead';
            return '';
          },
        },
      });
      expect(r.kind).toBe('delivered-pr');
      if (r.kind !== 'delivered-pr') return;
      expect(r.prUrl).toBe('https://github.com/o/r/pull/9');
      expect(r.headSha).toBe('rebasedhead');
      expect(r.commitLeaks.length).toBeGreaterThan(0);
    });
    const gh = calls.find((c) => c[0] === 'gh');
    expect(gh?.[gh.indexOf('--title') + 1]).toBe('feat: thing (o/r#7)');
    expect(gh?.[gh.indexOf('--body') + 1]).toMatch(/leaks=[1-9]/);
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'push')).toBe(true);
  });

  it('redacts an injected credential out of the commit message, the PR title (scope included) and the body, logging counts only', async () => {
    const credential = 'opaque-credential-92837';
    const logged: string[] = [];
    const log = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    const calls: string[][] = [];
    try {
      vi.stubEnv('OPENAI_API_KEY', credential);
      await withWork('work', async (ctx) => {
        const r = await deliverChange(ctx, {
          taskId: 'o/r#7',
          commitMessage: `feat: thing ${credential}`,
          target: {
            kind: 'new-pr',
            title: `thing ${credential}`,
            scope: credential,
            body: () => `body ${credential}`,
            runner: async (file, a) => {
              calls.push([file, ...a]);
              return file === 'gh' ? 'https://github.com/o/r/pull/9' : '';
            },
          },
        });
        expect(r.kind).toBe('delivered-pr');
        expect((await execa('git', ['log', '-1', '--format=%s'], { cwd: ctx.worktreePath })).stdout).toBe('feat: thing [REDACTED-INJECTED]');
      });
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
    const gh = calls.find((c) => c[0] === 'gh');
    expect(gh?.[gh.indexOf('--title') + 1]).toBe('feat([REDACTED-INJECTED]): thing [REDACTED-INJECTED]');
    expect(gh?.[gh.indexOf('--body') + 1]).toBe('body [REDACTED-INJECTED]');
    expect(JSON.stringify(calls)).not.toContain(credential);
    // One count-only line per redacted field (commit message, PR title, PR body), never the value.
    expect(logged.filter((l) => l.includes('redacted'))).toEqual([
      'vanguard: redacted 1 injected credential occurrence(s) from the commit message for o/r#7 (values withheld)',
      'vanguard: redacted 2 injected credential occurrence(s) from the PR title for o/r#7 (values withheld)',
      'vanguard: redacted 1 injected credential occurrence(s) from the PR body for o/r#7 (values withheld)',
    ]);
    expect(logged.join('\n')).not.toContain(credential);
  });
});

describe('scanOutgoingForSecrets: injected credentials', () => {
  // Long and high-entropy like a real credential, but matching no SECRET_PATTERNS entry: only the
  // exact-value check against the run's own injected secrets can catch it.
  const credential = 'opaque-credential-92837';
  const diffOf = (line: string, path = 'tests/example.ts'): string =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n context\n-old\n+${line}\n+tail`;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('blocks on an injected credential the pattern scan exempts (test path + allowlist marker), with no pattern findings', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('OPENAI_API_KEY', credential);
    const block = scanOutgoingForSecrets(diffOf(`${credential} // gitleaks:allow`), 'T-1');
    expect(block).toEqual({ reason: 'findings', findings: [], injected: [{ file: 'tests/example.ts', line: 2 }] });
  });

  it('checks a caller-supplied extra env var name (a custom provider keyEnv)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('ACME_LLM_KEY', credential);
    expect(scanOutgoingForSecrets(diffOf(credential), 'T-1')).toBeUndefined();
    expect(scanOutgoingForSecrets(diffOf(credential), 'T-1', 'publish', ['ACME_LLM_KEY'])?.reason).toBe('findings');
  });

  it('never prints the credential in the block, the log line, or the comment', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('OPENAI_API_KEY', credential);
    const block = scanOutgoingForSecrets(diffOf(`Bearer abc123 ${credential}`, `${credential}.txt`), 'T-1');
    expect(block?.reason).toBe('findings');
    expect(JSON.stringify(block)).not.toContain(credential);
    expect(JSON.stringify(log.mock.calls)).not.toContain(credential);
    expect(renderSecretBlockComment(block!)).not.toContain(credential);
  });
});

describe('conventionalPrTitle', () => {
  it('selects the type and optional scope', () => {
    expect(conventionalPrTitle('Add search')).toBe('feat: Add search');
    expect(conventionalPrTitle('Repair search', { bugLabel: true, scope: 'hub' })).toBe('fix(hub): Repair search');
    expect(conventionalPrTitle('Repair search', { bugLabel: true, scope: '' })).toBe('fix: Repair search');
  });

  it.each(['feat: add search', 'fix(hub): repair search', 'feat!: change API', 'refactor(core)!: change API', 'chore: cleanup'])(
    'preserves an existing conventional title: %s', (title) => {
      expect(conventionalPrTitle(title, { bugLabel: true, scope: 'other' })).toBe(title);
    },
  );
});
