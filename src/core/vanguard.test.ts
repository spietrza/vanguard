import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import {
  run,
  prepareContext,
  runAgent,
  disposeContext,
  workflowPaths,
  assertNoWorkflowChanges,
  copyBackBudget,
  assertWorkspaceWithinCeiling,
} from './vanguard.js';
import { WorktreeManager } from '../worktree/manager.js';
import { skillRegistryForRun } from '../context/skill-registry.js';
import { SandboxError, WorkflowGuardError } from './errors.js';

describe('assertWorkspaceWithinCeiling', () => {
  const sandbox = (stdout: string, exitCode = 0): Pick<IsolatedSandboxProvider, 'exec'> & { commands: string[] } => {
    const commands: string[] = [];
    return { commands, exec: async (command: string) => { commands.push(command); return { exitCode, stdout, stderr: '' }; } };
  };

  it('measures inside the sandbox with node_modules and .git pruned, and passes under the ceiling', async () => {
    const sb = sandbox('3 30\n');
    await expect(assertWorkspaceWithinCeiling(sb, 100, 10)).resolves.toBeUndefined();
    expect(sb.commands[0]).toContain('-name node_modules -o -name .git');
  });

  it('refuses before anything is copied when bytes or files pass the ceiling', async () => {
    await expect(assertWorkspaceWithinCeiling(sandbox('3 101\n'), 100, 10)).rejects.toThrow(SandboxError);
    await expect(assertWorkspaceWithinCeiling(sandbox('11 0\n'), 100, 10)).rejects.toThrow(/copy-back ceiling/);
  });

  it('skips (leaving the staging budget) when the measurement does not parse', async () => {
    await expect(assertWorkspaceWithinCeiling(sandbox('find: unknown predicate', 0), 1, 1)).resolves.toBeUndefined();
    await expect(assertWorkspaceWithinCeiling(sandbox('', 1), 1, 1)).resolves.toBeUndefined();
  });
});

describe('copyBackBudget', () => {
  const file = (size: number): { isDirectory: () => boolean; size: number } => ({ isDirectory: () => false, size });
  const dir = { isDirectory: () => true, size: 1_000_000 };

  it('passes up to the ceiling, ignoring directories', () => {
    const charge = copyBackBudget(10, 2);
    charge(dir);
    charge(file(4));
    expect(() => charge(file(6))).not.toThrow();
  });

  it('throws a clear SandboxError once total size passes the ceiling', () => {
    const charge = copyBackBudget(10, 100);
    charge(file(10));
    expect(() => charge(file(1))).toThrow(SandboxError);
    expect(() => copyBackBudget(10, 100)(file(11))).toThrow(/copy-back ceiling/);
  });

  it('throws once the file count passes the ceiling', () => {
    const charge = copyBackBudget(1_000, 2);
    charge(file(0));
    charge(file(0));
    expect(() => charge(file(0))).toThrow(/copy-back ceiling/);
  });
});
import type { RunOptions } from './types.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';
import type { VanguardLogger } from './logger.js';

interface LogEntry {
  obj: Record<string, unknown>;
  msg: string;
}

interface CaptureLogger {
  logger: VanguardLogger;
  entries: LogEntry[];
}

/** A Pino-shaped logger that records every call so tests can assert on emitted lifecycle logs. */
function captureLogger(): CaptureLogger {
  const entries: LogEntry[] = [];
  const record = (obj: Record<string, unknown>, msg: string): void => {
    entries.push({ obj, msg });
  };
  const logger = {
    info: record,
    warn: record,
    error: record,
    debug: record,
  } as unknown as VanguardLogger;
  return { logger, entries };
}

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vg-orch-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# r');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

interface FakeSandbox {
  sandbox: IsolatedSandboxProvider;
  wasDestroyed: () => boolean;
}

function makeSandbox(onWorkdirCopyOut?: (hostPath: string) => Promise<void>): FakeSandbox {
  let destroyed = false;
  const sandbox = {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> => {
      if (command.includes('$HOME')) return { stdout: '/root', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    execStream: () => ({
      stdout: (async function* () {})(),
      result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
      if (sandboxPath === '/workspace' && onWorkdirCopyOut) await onWorkdirCopyOut(hostPath);
    },
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {
      destroyed = true;
    },
  } as unknown as IsolatedSandboxProvider;
  return { sandbox, wasDestroyed: () => destroyed };
}

function fakeAgent(turns: AgentTurn[], output: AgentRunOutput): AgentProvider {
  return {
    name: 'fake',
    async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      for (const turn of turns) yield turn;
      return output;
    },
  };
}

describe('vanguard.run', () => {
  it('completes on the termination signal and preserves a dirty worktree', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox(async (hostPath) => {
      await mkdir(hostPath, { recursive: true });
      await writeFile(join(hostPath, 'result.txt'), 'done');
    });
    const agent = fakeAgent(
      [{ text: 'step 1' }, { text: 'done <promise>COMPLETE</promise>' }],
      { finalText: 'done <promise>COMPLETE</promise>', sessionId: 's1', turns: 2 },
    );
    const opts: RunOptions = {
      taskId: 't1',
      localRepoPath: repo,
      promptTemplate: 'do {{X}}',
      variables: { X: 'to' },
      sandbox,
      agent,
    };
    const res = await run(opts, { worktrees: wm });
    expect(res.completed).toBe(true);
    expect(res.exitReason).toBe('completed');
    expect(res.turns).toBe(2);
    expect(res.sessionId).toBe('s1');
    expect(res.worktreePreserved).toBe(true);
    expect(res.diff).toContain('result.txt');
    expect(wasDestroyed()).toBe(true);
  });

  it('warns when a gateway serves a different model than the requested full id', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const { logger, entries } = captureLogger();
    const agent = fakeAgent([{ text: 'ok' }], { finalText: 'ok', turns: 1, model: 'claude-sonnet-4-6' });
    await run(
      { taskId: 't-mismatch', localRepoPath: repo, promptTemplate: 'do', sandbox, agent, model: 'claude-fable-5', logger },
      { worktrees: wm },
    );
    const warn = entries.find((e) => e.msg.includes('model mismatch'));
    expect(warn).toBeDefined();
    expect(warn?.obj.requested).toBe('claude-fable-5');
    expect(warn?.obj.served).toBe('claude-sonnet-4-6');
  });

  it('does not warn when an alias request resolves to a versioned id', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const { logger, entries } = captureLogger();
    const agent = fakeAgent([{ text: 'ok' }], { finalText: 'ok', turns: 1, model: 'claude-opus-4-8' });
    await run(
      { taskId: 't-alias', localRepoPath: repo, promptTemplate: 'do', sandbox, agent, model: 'opus', logger },
      { worktrees: wm },
    );
    expect(entries.some((e) => e.msg.includes('model mismatch'))).toBe(false);
  });

  it('does not warn for cursor, which serves a claude-* request through an Auto mode', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const { logger, entries } = captureLogger();
    const agent = { ...fakeAgent([{ text: 'ok' }], { finalText: 'ok', turns: 1, model: 'Grok 4.7' }), name: 'cursor' };
    await run(
      { taskId: 't-cursor-model', localRepoPath: repo, promptTemplate: 'do', sandbox, agent, model: 'claude-fable-5-1', logger },
      { worktrees: wm },
    );
    expect(entries.some((e) => e.msg.includes('model mismatch'))).toBe(false);
  });

  it('removes a clean worktree and reports not-completed', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox();
    const agent = fakeAgent([{ text: 'nothing' }], { finalText: 'nothing', turns: 1 });
    const res = await run(
      { taskId: 't2', localRepoPath: repo, promptTemplate: 'x', sandbox, agent },
      { worktrees: wm },
    );
    expect(res.completed).toBe(false);
    expect(res.exitReason).toBe('incomplete');
    expect(res.worktreePreserved).toBe(false);
    expect(wasDestroyed()).toBe(true);
  });

  it('reuses one context across multiple agent stages (R11)', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox();
    const ctx = await prepareContext({ taskId: 't3', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const a1 = await runAgent(ctx, {
      promptTemplate: 'a',
      agent: fakeAgent([{ text: 'one' }], { finalText: 'one', turns: 1, sessionId: 's' }),
    });
    const a2 = await runAgent(ctx, {
      promptTemplate: 'b',
      agent: fakeAgent([{ text: 'two' }], { finalText: 'two', turns: 1, sessionId: 's' }),
      resumeSessionId: 's',
    });
    expect(a1.turns).toBe(1);
    expect(a2.turns).toBe(1);
    expect(wasDestroyed()).toBe(false);
    await disposeContext(ctx);
    expect(wasDestroyed()).toBe(true);
  });

  it('a cursor resume never restores a Claude session jsonl (none was captured; copyIn would throw)', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const probed: string[] = [];
    sandbox.exists = async (path: string): Promise<boolean> => {
      probed.push(path);
      return false;
    };
    sandbox.copyIn = async (hostPath: string): Promise<void> => {
      if (hostPath.endsWith('.jsonl')) throw new Error(`copyIn ${hostPath}`);
    };
    const ctx = await prepareContext({ taskId: 't-cursor-resume', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const agent = { ...fakeAgent([{ text: 'two' }], { finalText: 'two', turns: 1, sessionId: 'chat-1' }), name: 'cursor' };
    const res = await runAgent(ctx, { promptTemplate: 'b', agent, resumeSessionId: 'chat-1' });
    expect(res.turns).toBe(1);
    expect(probed.some((p) => p.includes('chat-1'))).toBe(false);
    await disposeContext(ctx);
  });

  it('a reuse start asks WorktreeManager.create for the existing branch', async () => {
    const wm = new WorktreeManager(repo);
    const spy = vi.spyOn(wm, 'create');
    const { sandbox } = makeSandbox();
    const ctx = await prepareContext({ taskId: 'reuse-test', localRepoPath: repo, baseBranch: 'main', start: 'reuse', sandbox }, { worktrees: wm });
    await disposeContext(ctx);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[2]).toEqual({ reuse: true });
  });

  it('keeps the sandbox alive when disposeContext is told to keep it', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox, wasDestroyed } = makeSandbox();
    const ctx = await prepareContext({ taskId: 'keep', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    await disposeContext(ctx, { keep: true });
    expect(wasDestroyed()).toBe(false);
  });

  it('a skills resolver reads repo skills from the new worktree, not the host checkout', async () => {
    const skill = async (root: string, id: string): Promise<void> => {
      await mkdir(join(root, '.github', 'vanguard-skills', id), { recursive: true });
      await writeFile(join(root, '.github', 'vanguard-skills', id, 'SKILL.md'), '---\nname: s\ndescription: d\n---\n');
    };
    await skill(repo, 'deploy');
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'skills'], { cwd: repo });
    await skill(repo, 'local-only'); // in the host checkout, not on main
    const { sandbox } = makeSandbox();
    const copied: string[] = [];
    sandbox.copyIn = async (_hostPath: string, to: string): Promise<void> => {
      copied.push(to);
    };
    const resolvedFrom: string[] = [];
    const ctx = await prepareContext(
      { taskId: 'skills-wt', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox },
      {
        worktrees: new WorktreeManager(repo),
        skills: (worktreePath) => {
          resolvedFrom.push(worktreePath);
          return skillRegistryForRun(undefined, worktreePath);
        },
      },
    );
    await disposeContext(ctx);
    expect(resolvedFrom).toEqual([ctx.worktreePath]);
    expect(copied).toContain('/root/.claude/skills/deploy');
    expect(copied).not.toContain('/root/.claude/skills/local-only');
  });

  it('reports cacheEfficiency from agent usage', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const agent = fakeAgent([{ text: 'x' }], {
      finalText: 'x',
      turns: 1,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 300 },
    });
    const res = await run({ taskId: 'ce', localRepoPath: repo, promptTemplate: 'p', sandbox, agent }, { worktrees: wm });
    expect(res.cacheEfficiency).toBeCloseTo(0.75);
  });

  it('skips copyFileOut and produces no diff when copyBack is false', async () => {
    const wm = new WorktreeManager(repo);
    let copyFileOutCalled = false;
    const sandbox = {
      id: 'fake',
      start: async (): Promise<void> => {},
      exec: async (command: string): Promise<ExecResult> => {
        if (command.includes('$HOME')) return { stdout: '/root', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      execStream: () => ({
        stdout: (async function* () {})(),
        result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      copyIn: async (): Promise<void> => {},
      copyFileOut: async (): Promise<void> => {
        copyFileOutCalled = true;
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
    } as unknown as IsolatedSandboxProvider;

    const agent = fakeAgent([{ text: 'noop' }], { finalText: 'noop', turns: 1 });
    const ctx = await prepareContext({ taskId: 'cb-false', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent, copyBack: false });
    await disposeContext(ctx);

    expect(copyFileOutCalled).toBe(false);
    expect(result.diff).toBeUndefined();
    // Worktree left untouched (clean)
    expect(result.worktreePreserved).toBe(false);
  });

  it('calls copyFileOut and captures a diff when copyBack is undefined (default)', async () => {
    const wm = new WorktreeManager(repo);
    let copyFileOutCalled = false;
    const sandbox = {
      id: 'fake',
      start: async (): Promise<void> => {},
      exec: async (command: string): Promise<ExecResult> => {
        if (command.includes('$HOME')) return { stdout: '/root', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      execStream: () => ({
        stdout: (async function* () {})(),
        result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      copyIn: async (): Promise<void> => {},
      copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
        copyFileOutCalled = true;
        if (sandboxPath === '/workspace') {
          await mkdir(hostPath, { recursive: true });
          await writeFile(join(hostPath, 'output.txt'), 'created');
        }
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
    } as unknown as IsolatedSandboxProvider;

    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'cb-default', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(copyFileOutCalled).toBe(true);
    expect(result.diff).toContain('output.txt');
  });

  it('treats copyBack: true the same as the default (copies out, captures a diff)', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(hostPath, { recursive: true });
      await writeFile(join(hostPath, 'output.txt'), 'created');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'cb-true', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent, copyBack: true });
    await disposeContext(ctx);

    expect(result.diff).toContain('output.txt');
  });

  it('falls back to the configured model when the provider does not report one', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const agent = fakeAgent([], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'model-fallback', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent, model: 'configured-model' });
    await disposeContext(ctx);

    expect(result.model).toBe('configured-model');
  });

  it('uses the provider-reported model over the configured model', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const agent = fakeAgent([], { finalText: 'done', turns: 1, model: 'actual-model' });
    const ctx = await prepareContext({ taskId: 'model-reported', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent, model: 'configured-model' });
    await disposeContext(ctx);

    expect(result.model).toBe('actual-model');
  });

  function sessionTrackingSandbox(sessionCopyOut: () => void): IsolatedSandboxProvider {
    return {
      id: 'fake',
      start: async (): Promise<void> => {},
      exec: async (command: string): Promise<ExecResult> =>
        command.includes('$HOME') ? { stdout: '/root', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 0 },
      execStream: () => ({ stdout: (async function* () {})(), result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) }),
      copyIn: async (): Promise<void> => {},
      copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
        if (sandboxPath === '/workspace') {
          await mkdir(hostPath, { recursive: true });
          return;
        }
        sessionCopyOut(); // a session-jsonl copy was attempted
        throw new Error('no such file');
      },
      exists: async (): Promise<boolean> => true,
      destroy: async (): Promise<void> => {},
    } as unknown as IsolatedSandboxProvider;
  }

  it('drops a forged session id: no session copy ever leaves the sessions dir, no restore runs', async () => {
    const wm = new WorktreeManager(repo);
    const hostPaths: string[] = [];
    const sandbox = {
      ...(sessionTrackingSandbox(() => undefined) as unknown as Record<string, unknown>),
      copyIn: async (hostPath: string): Promise<void> => {
        if (hostPath.endsWith('.jsonl')) hostPaths.push(hostPath); // a session restore, not the worktree copy-in
      },
      copyFileOut: async (sandboxPath: string, hostPath: string): Promise<void> => {
        if (sandboxPath === '/workspace') {
          await mkdir(hostPath, { recursive: true });
          return;
        }
        hostPaths.push(hostPath);
      },
      exists: async (): Promise<boolean> => false,
    } as unknown as IsolatedSandboxProvider;
    const agent: AgentProvider = {
      name: 'claude-code',
      async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        yield { text: 'working', sessionId: '../x' };
        return { finalText: 'done', turns: 1, sessionId: '../../runs/metrics' };
      },
    };
    const ctx = await prepareContext({ taskId: 'forged-sid', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent, resumeSessionId: '../../../../tmp/other' });
    await disposeContext(ctx);

    expect(result.sessionId).toBeUndefined();
    expect(hostPaths).toEqual([]);
  });

  it('does not attempt session capture for a non-Claude provider (codex reports a sessionId but writes no jsonl)', async () => {
    const wm = new WorktreeManager(repo);
    let captureAttempted = false;
    const sandbox = sessionTrackingSandbox(() => { captureAttempted = true; });
    const agent: AgentProvider = {
      name: 'codex',
      async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'reviewed', turns: 1, sessionId: 'codex-thread-1' };
      },
    };
    const ctx = await prepareContext({ taskId: 'cap-skip', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.finalText).toBe('reviewed');
    expect(captureAttempted).toBe(false); // skipped by provider, not attempted-and-swallowed
  });

  for (const name of ['openrouter', 'meridian', 'custom:acme-gateway']) {
    it(`attempts session capture for ${name} — every adapter that drives the Claude CLI, not only two names`, async () => {
      const wm = new WorktreeManager(repo);
      let captureAttempted = false;
      const sandbox = sessionTrackingSandbox(() => { captureAttempted = true; });
      const agent: AgentProvider = {
        name,
        async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
          return { finalText: 'done', turns: 1, sessionId: 's1' };
        },
      };
      const ctx = await prepareContext({ taskId: `cap-${name.replace(/[^a-z0-9]/gi, '-')}`, localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
      await runAgent(ctx, { promptTemplate: 'p', agent });
      await disposeContext(ctx);
      expect(captureAttempted).toBe(true);
    });
  }

  it('does not fail a claude-family stage when session capture fails (non-fatal, attempted)', async () => {
    const wm = new WorktreeManager(repo);
    let captureAttempted = false;
    const sandbox = sessionTrackingSandbox(() => { captureAttempted = true; });
    const agent: AgentProvider = {
      name: 'claude-code',
      async *run(): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
        return { finalText: 'done', turns: 1, sessionId: 's1' };
      },
    };
    const ctx = await prepareContext({ taskId: 'cap-warn', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.finalText).toBe('done');
    expect(captureAttempted).toBe(true); // claude-family: capture is attempted, failure caught and warned
  });

  it('emits a stage complete info log carrying metric fields and no secret content', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const { logger, entries } = captureLogger();
    const agent = fakeAgent([{ text: 'secret model output' }], {
      finalText: 'secret model output',
      turns: 1,
      usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 },
      costUsd: 0.01,
    });
    const ctx = await prepareContext(
      { taskId: 'log-1', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox, logger },
      { worktrees: wm },
    );
    await runAgent(ctx, { promptTemplate: 'p', agent, stageName: 'implementer' });
    await disposeContext(ctx);

    expect(entries.some((e) => e.msg === 'run start')).toBe(true);
    const start = entries.find((e) => e.msg === 'stage start');
    expect(start?.obj.stage).toBe('implementer');

    const complete = entries.find((e) => e.msg === 'stage complete');
    expect(complete).toBeDefined();
    expect(complete?.obj).toHaveProperty('durationMs');
    expect(complete?.obj).toHaveProperty('costUsd');
    expect(complete?.obj.stage).toBe('implementer');
    // SECRET SAFETY: stage-complete must never carry model output / prompt content.
    expect(complete?.obj).not.toHaveProperty('finalText');
    expect(complete?.obj).not.toHaveProperty('diff');
    expect(complete?.obj).not.toHaveProperty('transcript');
    expect(JSON.stringify(complete?.obj)).not.toContain('secret model output');
  });

  it('does not copy a sandbox-authored .github/workflows file back to the worktree', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(join(hostPath, '.github', 'workflows'), { recursive: true });
      await writeFile(join(hostPath, '.github', 'workflows', 'evil.yml'), 'on: push\njobs: {}\n');
      await mkdir(join(hostPath, 'src'), { recursive: true });
      await writeFile(join(hostPath, 'src', 'app.ts'), 'export const x = 1;\n');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'wf-skip', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.diff).toContain('app.ts');
    expect(result.diff ?? '').not.toContain('.github/workflows');
    expect(existsSync(join(repo, '.github', 'workflows', 'evil.yml'))).toBe(false);
  });

  it('logs a loud warning when a .github/workflows path is dropped on copy-back', async () => {
    const wm = new WorktreeManager(repo);
    const { logger, entries } = captureLogger();
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(join(hostPath, '.github', 'workflows'), { recursive: true });
      await writeFile(join(hostPath, '.github', 'workflows', 'evil.yml'), 'on: push\njobs: {}\n');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'wf-warn', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox, logger }, { worktrees: wm });
    await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    const warning = entries.find((e) => e.msg.includes('dropped CI config path'));
    expect(warning).toBeDefined();
    expect(String(warning?.obj.paths)).toContain('.github/workflows');
  });

  it('does not copy sandbox-authored GitLab CI config back to the worktree', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox(async (hostPath) => {
      await writeFile(join(hostPath, '.gitlab-ci.yml'), 'workflow:\n  rules: []\n');
      await mkdir(join(hostPath, '.gitlab', 'ci'), { recursive: true });
      await writeFile(join(hostPath, '.gitlab', 'ci', 'evil.yml'), 'evil:\n  script: [env]\n');
      await writeFile(join(hostPath, '.gitlab', 'ci', 'upper.YML'), 'upper:\n  script: [env]\n');
      await writeFile(join(hostPath, 'app.gitlab-ci.yml.md'), 'notes\n');
      await mkdir(join(hostPath, '.gitlab', 'merge_request_templates'), { recursive: true });
      await writeFile(join(hostPath, '.gitlab', 'merge_request_templates', 'default.md'), 'template\n');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'gl-skip', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.diff).toContain('app.gitlab-ci.yml.md');
    expect(result.diff).toContain('.gitlab/merge_request_templates/default.md');
    expect(result.diff ?? '').not.toContain('.gitlab/ci');
    expect(result.diff ?? '').not.toContain('workflow:');
    expect(existsSync(join(repo, '.gitlab', 'ci', 'evil.yml'))).toBe(false);
    expect(existsSync(join(repo, '.gitlab', 'ci', 'upper.YML'))).toBe(false);
  });

  it('still copies back sibling .github files like dependabot.yml', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(join(hostPath, '.github'), { recursive: true });
      await writeFile(join(hostPath, '.github', 'dependabot.yml'), 'version: 2\n');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'wf-sibling', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.diff).toContain('dependabot.yml');
  });

  it('records the CI config the agent added or edited, not unchanged copies of it', async () => {
    // Identical on both sides, but above the compare cap, so it is reported without being read.
    const huge = `# ${'x'.repeat(4 * 1024 * 1024)}\n`;
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await mkdir(join(repo, '.gitlab'), { recursive: true });
    await writeFile(join(repo, '.gitlab-ci.yml'), 'stages: [test]\n');
    await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    await writeFile(join(repo, '.gitlab', 'linked.yml'), 'same\n');
    await writeFile(join(repo, '.gitlab', 'same-size.yml'), 'job: a\n');
    await writeFile(join(repo, '.gitlab', 'huge.yml'), huge);
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'ci'], { cwd: repo });
    const outside = join(repo, '..', `${basename(repo)}-target.yml`);
    await writeFile(outside, 'same\n');
    const wm = new WorktreeManager(repo);
    const { logger, entries } = captureLogger();
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(join(hostPath, '.github', 'workflows'), { recursive: true });
      await mkdir(join(hostPath, '.gitlab', 'ci'), { recursive: true });
      await writeFile(join(hostPath, '.gitlab-ci.yml'), 'stages: [test]\n');
      await writeFile(join(hostPath, '.github', 'workflows', 'ci.yml'), 'on: pull_request\n');
      await writeFile(join(hostPath, '.gitlab', 'ci', 'new.yml'), 'new:\n  script: [env]\n');
      await writeFile(join(hostPath, '.gitlab', 'same-size.yml'), 'job: b\n');
      await writeFile(join(hostPath, '.gitlab', 'huge.yml'), huge);
      // Same bytes through the link, but a symlink is compared by target, never read through.
      await symlink(outside, join(hostPath, '.gitlab', 'linked.yml'));
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'ci-changed', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox, logger }, { worktrees: wm });
    await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);
    await rm(outside, { force: true });

    const expected = ['.github/workflows/ci.yml', '.gitlab/ci/new.yml', '.gitlab/huge.yml', '.gitlab/linked.yml', '.gitlab/same-size.yml'];
    expect([...(ctx.droppedCiPaths ?? [])].sort()).toEqual(expected);
    const warnings = entries.filter((e) => e.msg.includes('dropped CI config path'));
    expect(warnings).toHaveLength(1);
    expect([...(warnings[0]?.obj.paths as string[])].sort()).toEqual(expected);
  });

  it('drops a .gitlab or .github entry that stands in for the directory, and symlinks inside one', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(join(hostPath, 'ci-src', 'ci'), { recursive: true });
      await writeFile(join(hostPath, 'ci-src', 'ci', 'job.yml'), 'job:\n  script: [env]\n');
      await mkdir(join(hostPath, 'gh', 'workflows'), { recursive: true });
      await writeFile(join(hostPath, 'gh', 'workflows', 'x.yml'), 'on: push\n');
      await symlink('ci-src', join(hostPath, '.gitlab'));
      await symlink('gh', join(hostPath, '.github'));
      await mkdir(join(hostPath, 'sub', '.github', 'ISSUE_TEMPLATE'), { recursive: true });
      await symlink('../../gh', join(hostPath, 'sub', '.github', 'workflows-src'));
      await writeFile(join(hostPath, 'sub', '.github', 'ISSUE_TEMPLATE', 'bug.md'), 'bug\n');
      await writeFile(join(hostPath, 'sub', '.gitlab'), 'not a directory\n');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'ci-symlink', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    const linked = await Promise.all(['.gitlab', '.github'].map((name) => lstat(join(ctx.worktreePath, name)).then(() => true, () => false)));
    await disposeContext(ctx);

    expect(linked).toEqual([false, false]);
    expect([...(ctx.droppedCiPaths ?? [])].sort()).toEqual(['.github', '.gitlab', 'sub/.github/workflows-src', 'sub/.gitlab']);
    // A real directory under the same name still syncs back.
    expect(result.diff).toContain('sub/.github/ISSUE_TEMPLATE/bug.md');
  });

  it('logs one capped warning however many CI files the agent writes', async () => {
    const wm = new WorktreeManager(repo);
    const { logger, entries } = captureLogger();
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(join(hostPath, '.gitlab', 'ci'), { recursive: true });
      for (let i = 0; i < 25; i++) await writeFile(join(hostPath, '.gitlab', 'ci', `job-${i}.yml`), `job${i}: {}\n`);
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'ci-flood', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox, logger }, { worktrees: wm });
    await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    const warnings = entries.filter((e) => e.msg.includes('dropped CI config path'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.obj.count).toBe(25);
    expect(warnings[0]?.obj.paths).toHaveLength(20);
    expect(ctx.droppedCiPaths?.size).toBe(25);
  });

  describe('workflowPaths', () => {
    it('finds GitHub workflows and local actions, nested ones included', () => {
      expect(
        workflowPaths(['src/a.ts', '.github/workflows/nested/sub.yml', '.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.github/actions/setup/run.sh']),
      ).toEqual(['.github/actions/setup/action.yml', '.github/actions/setup/run.sh', '.github/workflows/ci.yml', '.github/workflows/nested/sub.yml']);
    });

    it('finds GitLab CI config: .gitlab-ci.yml and YAML under .gitlab/, with spaces or newlines and in any case', () => {
      const paths = ['.gitlab-ci.yml', 'sub/.gitlab-ci.yml', '.gitlab/ci/verify.yml', '.gitlab/deploy.yaml', '.gitlab/ci build.yml', '.gitlab/ci\nevil.yml', '.gitlab/ci/job.YML', '.GitLab-CI.yml'];
      expect(workflowPaths(paths)).toEqual([...paths].sort());
    });

    it('flags a changed path named .github or .gitlab, which git lists only for a file or symlink', () => {
      expect(workflowPaths(['.gitlab', 'sub/.github', '.gitlabx', '.github-old', 'docs/.gitlab.md'])).toEqual(['.gitlab', 'sub/.github']);
    });

    it('ignores other .github and .gitlab files and near-miss names', () => {
      expect(
        workflowPaths([
          'src/a.ts',
          '.github/dependabot.yml',
          '.github/CODEOWNERS',
          '.gitlab/merge_request_templates/default.md',
          '.gitlab/CODEOWNERS',
          '.gitlab/notes.yml.md',
          '.gitlab-ci.yml.orig',
          'app.gitlab-ci.yml.md',
          '.gitlabx/ci.yml',
          '.github/workflow/ci.yml',
          '.githubx/workflows/ci.yml',
        ]),
      ).toEqual([]);
    });

    it('sees changes git records only in headers, and not CI paths quoted in file content', async () => {
      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repo, '.gitlab', 'ci'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
      await writeFile(join(repo, '.gitlab', 'ci', 'job.yml'), 'job: {}\n');
      await execa('git', ['add', '.'], { cwd: repo });
      await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'ci'], { cwd: repo });
      // Custom diff prefixes must not hide anything.
      await execa('git', ['config', 'diff.srcPrefix', 'src/'], { cwd: repo });
      await execa('git', ['config', 'diff.dstPrefix', 'dst/'], { cwd: repo });
      const wm = new WorktreeManager(repo);
      const ctx = await prepareContext({ taskId: 'wf-paths', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox: makeSandbox().sandbox }, { worktrees: wm });

      await chmod(join(ctx.worktreePath, '.github', 'workflows', 'ci.yml'), 0o755);
      await writeFile(join(ctx.worktreePath, '.gitlab', 'ci', 'job.yml'), Buffer.from([0, 1, 2, 0]));
      // Added lines render as `+++ b/...` and `+-- ...` in a unified diff.
      await writeFile(join(ctx.worktreePath, 'notes.sql'), '++ b/.github/workflows/evil.yml\n-- .gitlab/ci/evil.yml\n');

      expect(workflowPaths(await wm.changedPaths(ctx.worktreePath))).toEqual(['.github/workflows/ci.yml', '.gitlab/ci/job.yml']);
      await disposeContext(ctx);
    });
  });

  describe('assertNoWorkflowChanges', () => {
    it('throws WorkflowGuardError and logs error with the offending paths', () => {
      const { logger, entries } = captureLogger();
      expect(() => assertNoWorkflowChanges(['src/a.ts', '.github/workflows/ci.yml'], logger, 't-guard')).toThrow(WorkflowGuardError);
      const error = entries.find((e) => e.msg.includes('blocked commit'));
      expect(error).toBeDefined();
      expect(error?.obj.paths).toEqual(['.github/workflows/ci.yml']);
    });

    it('does not throw when no changed path is CI config', () => {
      const { logger, entries } = captureLogger();
      expect(() => assertNoWorkflowChanges(['src/index.ts'], logger, 't-guard-clean')).not.toThrow();
      expect(entries.length).toBe(0);
    });
  });

  it('blocks the run when a .github/workflows change reaches the worktree diff (guard backstop)', async () => {
    const wm = new WorktreeManager(repo);
    const { sandbox } = makeSandbox();
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'wf-guard-block', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox }, { worktrees: wm });
    // Simulate a bypass of the copy-back skip (e.g. a future regression) by placing a workflow
    // file directly on the worktree, as the guard's job is to catch exactly this.
    await mkdir(join(ctx.worktreePath, '.github', 'workflows'), { recursive: true });
    await writeFile(join(ctx.worktreePath, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');

    await expect(runAgent(ctx, { promptTemplate: 'p', agent })).rejects.toThrow(WorkflowGuardError);
    await disposeContext(ctx);
  });

  it('does not warn or error for a normal diff (guard passes silently)', async () => {
    const wm = new WorktreeManager(repo);
    const { logger, entries } = captureLogger();
    const { sandbox } = makeSandbox(async (hostPath) => {
      await mkdir(join(hostPath, 'src'), { recursive: true });
      await writeFile(join(hostPath, 'src', 'app.ts'), 'export const x = 1;\n');
    });
    const agent = fakeAgent([{ text: 'done' }], { finalText: 'done', turns: 1 });
    const ctx = await prepareContext({ taskId: 'wf-normal', localRepoPath: repo, baseBranch: 'main', start: 'base', sandbox, logger }, { worktrees: wm });
    const result = await runAgent(ctx, { promptTemplate: 'p', agent });
    await disposeContext(ctx);

    expect(result.diff).toContain('app.ts');
    expect(entries.some((e) => e.msg.includes('workflows'))).toBe(false);
  });
});

describe('vanguard.run base resolution (#429)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const commitFile = async (cwd: string, content: string): Promise<void> => {
    await writeFile(join(cwd, 'f.txt'), content);
    await execa('git', ['add', '.'], { cwd });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', content], { cwd });
  };

  it('cuts the worktree from origin when the remote base moved past the local checkout', async () => {
    const origin = await mkdtemp(join(tmpdir(), 'vg-origin-'));
    dirs.push(origin);
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: origin });
    await commitFile(origin, 'v1');
    const clone = await mkdtemp(join(tmpdir(), 'vg-clone-'));
    dirs.push(clone);
    await execa('git', ['clone', '-q', origin, clone]);
    await commitFile(origin, 'v2'); // main moved after the checkout — the #423 window

    let copiedIn = '';
    const { sandbox } = makeSandbox();
    // copyIn(hostPath = the freshly cut worktree, '/workspace'): capture what the sandbox is seeded with.
    (sandbox as unknown as { copyIn: (hostPath: string) => Promise<void> }).copyIn = async (hostPath) => {
      copiedIn = await readFile(join(hostPath, 'f.txt'), 'utf8');
    };
    const agent = fakeAgent([{ text: 'done <promise>COMPLETE</promise>' }], { finalText: 'done <promise>COMPLETE</promise>', sessionId: 's1', turns: 1 });
    await run({ taskId: 'rb', localRepoPath: clone, promptTemplate: 'p', sandbox, agent }, { worktrees: new WorktreeManager(clone) });
    // The sandbox received origin's tree, not the stale local main.
    expect(copiedIn).toBe('v2');
  });

  /** An origin with a `main` and a `feature` branch, and a clone whose local main is one commit behind origin's. */
  const originAndStaleClone = async (): Promise<{ origin: string; clone: string }> => {
    const origin = await mkdtemp(join(tmpdir(), 'vg-origin-'));
    dirs.push(origin);
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: origin });
    await commitFile(origin, 'v1');
    const clone = await mkdtemp(join(tmpdir(), 'vg-clone-'));
    dirs.push(clone);
    await execa('git', ['clone', '-q', origin, clone]);
    await execa('git', ['checkout', '-q', '-b', 'feature'], { cwd: origin });
    await commitFile(origin, 'feature-work');
    await execa('git', ['checkout', '-q', 'main'], { cwd: origin });
    await commitFile(origin, 'v2');
    return { origin, clone };
  };
  const sha = async (cwd: string, ref: string): Promise<string> => (await execa('git', ['rev-parse', ref], { cwd })).stdout;

  it('records the start commit once: origin/<base> for a base start, the local base for reuse, the fetched head for a PR head', async () => {
    const { origin, clone } = await originAndStaleClone();
    const { logger, entries } = captureLogger();
    const wm = new WorktreeManager(clone);
    const spy = vi.spyOn(wm, 'create');

    const base = await prepareContext({ taskId: 'start-base', localRepoPath: clone, baseBranch: 'main', start: 'base', sandbox: makeSandbox().sandbox, logger }, { worktrees: wm });
    await disposeContext(base);
    expect(base.startRef).toBe(await sha(origin, 'main'));
    expect(base.baseBranch).toBe('main');
    // Announced exactly once, and the worktree was cut from that very SHA.
    expect(entries.filter((e) => e.msg === 'run start').map((e) => e.obj.startRef)).toEqual([base.startRef]);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(base.startRef);

    const reuse = await prepareContext({ taskId: 'start-reuse', localRepoPath: clone, baseBranch: 'main', start: 'reuse', sandbox: makeSandbox().sandbox }, { worktrees: wm });
    await disposeContext(reuse);
    expect(reuse.startRef).toBe(await sha(clone, 'refs/heads/main')); // the local copy, never fetched
    expect(reuse.startRef).not.toBe(base.startRef);

    const head = await prepareContext({ taskId: 'start-head', localRepoPath: clone, baseBranch: 'main', start: { prHead: 'feature', headRefOid: await sha(origin, 'feature') }, sandbox: makeSandbox().sandbox }, { worktrees: wm });
    await disposeContext(head);
    expect(head.startRef).toBe(await sha(origin, 'feature'));
  });

  it('rejects a fetched branch with a different PR head before creating a worktree', async () => {
    const { origin, clone } = await originAndStaleClone();
    const wm = new WorktreeManager(clone);
    const create = vi.spyOn(wm, 'create');
    await expect(prepareContext({
      taskId: 'wrong-head', localRepoPath: clone, baseBranch: 'main',
      start: { prHead: 'feature', headRefOid: await sha(origin, 'main') },
      sandbox: makeSandbox().sandbox,
    }, { worktrees: wm })).rejects.toThrow(/expected PR head/);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails loudly when the start cannot be resolved instead of landing on a default', async () => {
    const { clone } = await originAndStaleClone();
    const wm = new WorktreeManager(clone);
    // A fresh reuse cut from a base this clone does not carry fails where it always did (the cut).
    await expect(
      prepareContext({ taskId: 'start-missing', localRepoPath: clone, baseBranch: 'no-such-branch', start: 'reuse', sandbox: makeSandbox().sandbox }, { worktrees: wm }),
    ).rejects.toThrow(/Failed to create worktree for start-missing/);
    await expect(
      prepareContext({ taskId: 'start-nohead', localRepoPath: clone, baseBranch: 'main', start: { prHead: 'no-such-branch', headRefOid: 'deadbeef' }, sandbox: makeSandbox().sandbox }, { worktrees: wm }),
    ).rejects.toThrow(/no-such-branch/);
    await expect(
      prepareContext({ taskId: 'start-unsafe', localRepoPath: clone, baseBranch: '--upload-pack=x', start: { prHead: 'feature', headRefOid: 'deadbeef' }, sandbox: makeSandbox().sandbox }, { worktrees: wm }),
    ).rejects.toThrow(/cannot start with "-"/);
  });

  it('a reuse start still resumes a run branch when the base has no local branch (tracking ref, then the branch tip)', async () => {
    const { origin, clone } = await originAndStaleClone();
    // `release` exists on origin and as a tracking ref here, but was never checked out locally.
    await execa('git', ['branch', 'release', 'main'], { cwd: origin });
    await execa('git', ['fetch', '-q', 'origin', 'release'], { cwd: clone });
    const wm = new WorktreeManager(clone, undefined, () => 'r1');
    const { logger, entries } = captureLogger();

    const first = await prepareContext({ taskId: 'resume', localRepoPath: clone, baseBranch: 'release', start: 'reuse', sandbox: makeSandbox().sandbox, logger }, { worktrees: wm });
    await disposeContext(first);
    expect(first.startRef).toBe(await sha(clone, 'refs/remotes/origin/release'));

    // The base gone entirely: the existing run branch is still picked up, measured from its own tip, and says so.
    await execa('git', ['branch', '-D', '-r', 'origin/release'], { cwd: clone });
    const resumed = await prepareContext({ taskId: 'resume', localRepoPath: clone, baseBranch: 'release', start: 'reuse', sandbox: makeSandbox().sandbox, logger }, { worktrees: wm });
    await disposeContext(resumed);
    expect(resumed.branch).toBe(first.branch);
    expect(resumed.startRef).toBe(await sha(clone, `refs/heads/${first.branch}`));
    expect(entries.some((e) => e.msg.includes('release is not a commit here'))).toBe(true);
  });
});
