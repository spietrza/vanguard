import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginRun as beginStoredRun, runsRoot, sanitizeTimestamp } from '../core/run-store.js';
import { invokeCoreMethod } from './sidecar.js';
import type { RunResult } from '../core/types.js';
import type { RunEvent } from '../pipeline/events.js';

// The S6 fail-fast contract: provider resolution is a FIRST statement of the createRun dep —
// before beginRun() (no armed AbortController left behind) and before the sandbox. These mocks
// prove the ordering: if resolution passed, beginRun/startSandboxContext WOULD be called.
const beginRun = vi.fn(() => new AbortController().signal);
const endRun = vi.fn();
vi.mock('./cancel.js', () => ({ beginRun: (): AbortSignal => beginRun(), endRun: (): void => endRun() }));
// Mirrors startSandboxContext's real shape just enough to exercise deps.ts: when the caller asks for
// llmProxy, hand back a nonce-bearing dep (never the real credential) like the trusted sidecar would.
const startSandboxContext = vi.fn(async (opts: { llmProxy?: boolean }) => ({
  destroy: async (): Promise<void> => {},
  ...(opts.llmProxy === true ? { llmProxy: { url: 'http://proxy.internal', nonce: 'nonce-xyz', host: 'proxy.internal' } } : {}),
}));
vi.mock('../sandbox/sandbox-context.js', () => ({
  startSandboxContext: (opts: unknown): Promise<unknown> => startSandboxContext(opts as { llmProxy?: boolean }),
}));
const githubDepsFromEnv = vi.fn(async () => ({ repoPath: '/r', repoSlug: 'o/r' }));
const runGithubIssue = vi.fn(async (_issueRef: string, _opts: Record<string, unknown>) => ({
  prUrl: 'https://example/pr/1',
}));
vi.mock('../runners/github.js', () => ({
  githubDepsFromEnv: (...args: unknown[]): Promise<unknown> => githubDepsFromEnv(...(args as [])),
  runGithubIssue: (...args: unknown[]): Promise<unknown> =>
    runGithubIssue(...(args as [string, Record<string, unknown>])),
}));

const { productionDeps } = await import('./deps.js');
const { BadRequestError } = await import('./sidecar.js');
const { SandboxError } = await import('../core/errors.js');

async function repoWith(customProviders: unknown): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'vg-deps-'));
  await mkdir(join(repo, '.vanguard'), { recursive: true });
  await writeFile(join(repo, '.vanguard', 'app.json'), JSON.stringify({ customProviders }));
  return repo;
}

/** A repo with no `.vanguard/app.json` at all — loadCustomProviders resolves to []. */
async function plainRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vg-deps-'));
}

const ENTRY = { name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_PROXY_API_KEY' };

/**
 * Apply env vars for one test (`undefined` = unset); the afterEach below restores them. The proxy
 * decision reads credentials off `process.env`, so every case must state the WHOLE picture — an
 * inherited CLAUDE_CODE_OAUTH_TOKEN would silently flip the Codex-subscription case.
 */
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
}

beforeEach(() => {
  beginRun.mockClear();
  endRun.mockClear();
  startSandboxContext.mockClear();
  githubDepsFromEnv.mockClear();
  runGithubIssue.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('createRun provider fail-fast (S6)', () => {
  it('unknown provider → BadRequestError BEFORE beginRun and the sandbox (no run record, no cost)', async () => {
    const repoPath = await repoWith([ENTRY]);
    const deps = productionDeps();
    await expect(
      deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'bogus' }, () => {}),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(beginRun).not.toHaveBeenCalled();
    expect(startSandboxContext).not.toHaveBeenCalled();
  });

  it('broken customs entry → BadRequestError quoting its recorded error', async () => {
    const repoPath = await repoWith([{ name: 'bad', baseUrl: 'nope', keyEnv: 'K' }]);
    const deps = productionDeps();
    await expect(deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'bad' }, () => {})).rejects.toThrow(
      /customProviders\[0\].*baseUrl/,
    );
    expect(beginRun).not.toHaveBeenCalled();
  });

  it('http custom → BadRequestError (createRun is always-egress; CLI-only endpoint)', async () => {
    const repoPath = await repoWith([{ ...ENTRY, baseUrl: 'http://nas.local:3456' }]);
    const deps = productionDeps();
    await expect(deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'my-proxy' }, () => {})).rejects.toThrow(
      /http:\/\/ endpoint/,
    );
    expect(beginRun).not.toHaveBeenCalled();
  });

  it('a healthy custom resolves: run proceeds with the custom host on the enclave allowlist', async () => {
    const repoPath = await repoWith([ENTRY]);
    const deps = productionDeps();
    setEnv({ MY_PROXY_API_KEY: 'sk-test' });
    const result = await deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'my-proxy' }, () => {});
    expect(result).toEqual({ prUrl: 'https://example/pr/1' });
    expect(beginRun).toHaveBeenCalledOnce();
    expect(startSandboxContext).toHaveBeenCalledWith(
      expect.objectContaining({ egress: true, extraEgressHosts: ['llm.example.com'] }),
    );
  });

  it('a healthy custom with the key MISSING still fails before beginRun (dispatch fail-fast, key named)', async () => {
    const repoPath = await repoWith([ENTRY]);
    const deps = productionDeps();
    await expect(deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'my-proxy' }, () => {})).rejects.toBeInstanceOf(
      BadRequestError, // caller-correctable → bad-request kind, uniform with unknown/broken/http (review #340 obs 3)
    );
    await expect(deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'my-proxy' }, () => {})).rejects.toThrow(
      /MY_PROXY_API_KEY/,
    );
    expect(beginRun).not.toHaveBeenCalled(); // auth resolves before beginRun — no armed controller left
    expect(startSandboxContext).not.toHaveBeenCalled();
  });
});

/**
 * The hub always runs with the LLM proxy: there is no switch, so the only question per run is whether
 * the chosen provider CAN be proxied — and when it cannot, that the exposure is announced instead of
 * silent. See docs/hub.md ("Runs always use the LLM proxy").
 */
describe('createRun always runs with the LLM proxy (#584)', () => {
  const NO_CLAUDE = { CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined };
  const CODEX_SUB = { CODEX_AUTH_JSON: '{"tokens":{"access_token":"t"}}' };

  it('a Claude subscription run is proxied: the runner gets the nonce dep, never the token', async () => {
    const repoPath = await plainRepo();
    const deps = productionDeps();
    setEnv({ ...NO_CLAUDE, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-REAL-TOKEN' });
    await expect(deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'claude' }, () => {})).resolves.toEqual({
      prUrl: 'https://example/pr/1',
    });
    expect(startSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ egress: true, llmProxy: true }));
    const [, opts] = runGithubIssue.mock.calls[0] ?? [];
    expect(opts?.llmProxy).toEqual({ url: 'http://proxy.internal', nonce: 'nonce-xyz', host: 'proxy.internal' });
    // The real credential reaches the trusted sidecar only: nothing the runner (hence the sandbox) sees.
    expect(JSON.stringify(runGithubIssue.mock.calls)).not.toContain('sk-ant-oat01-REAL-TOKEN');
  });

  it('a Codex-subscription run starts WITHOUT the proxy and warns once (the proxy cannot cover it)', async () => {
    const repoPath = await plainRepo();
    const deps = productionDeps();
    const events: RunEvent[] = [];
    setEnv({ ...NO_CLAUDE, ...CODEX_SUB });
    await expect(
      deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'codex' }, (e) => events.push(e)),
    ).resolves.toEqual({ prUrl: 'https://example/pr/1' });
    // No Claude credential is set, so demanding one for a proxy that protects nothing here would only
    // block the run (startSandboxContext throws without auth under llmProxy).
    expect(startSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ llmProxy: false }));
    // Exactly one, and it must be the SUBSCRIPTION advisory: a bare length check would also pass on the
    // direct-mode branch, which would be the wrong reason for codex (it is proxyable, just not on a sub).
    expect(events.filter((e) => e.type === 'warning')).toEqual([
      { type: 'warning', message: expect.stringContaining("codex's subscription credential") },
    ]);
  });

  it('a Codex-subscription run stays off the proxy even with an Anthropic key exported (nothing uses it)', async () => {
    const repoPath = await plainRepo();
    const deps = productionDeps();
    const events: RunEvent[] = [];
    setEnv({ ...NO_CLAUDE, ...CODEX_SUB, ANTHROPIC_API_KEY: 'sk-ant-REAL' });
    await expect(
      deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'codex' }, (e) => events.push(e)),
    ).resolves.toEqual({ prUrl: 'https://example/pr/1' });
    // A codex-only run consumes no Anthropic credential (needsAnthropicAuth is false), so an exported one
    // changes nothing: there is still nothing for a primary sidecar to hold, and turning the proxy on
    // would drop api.openai.com from the sandbox allowlist while the OpenAI sidecar has no API key to
    // forward with — it would break the run, not protect it.
    expect(startSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ llmProxy: false }));
    expect(events.filter((e) => e.type === 'warning')).toEqual([
      { type: 'warning', message: expect.stringContaining("codex's subscription credential") },
    ]);
    expect(JSON.stringify(runGithubIssue.mock.calls)).not.toContain('sk-ant-REAL');
  });

  it('a provider the proxy cannot run at all (repo custom) runs direct, with the same warning', async () => {
    const repoPath = await repoWith([ENTRY]);
    const deps = productionDeps();
    const events: RunEvent[] = [];
    setEnv({ ...NO_CLAUDE, MY_PROXY_API_KEY: 'sk-test' });
    await expect(
      deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'my-proxy' }, (e) => events.push(e)),
    ).resolves.toEqual({ prUrl: 'https://example/pr/1' });
    expect(startSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ llmProxy: false }));
    expect(events.filter((e) => e.type === 'warning')).toEqual([
      { type: 'warning', message: expect.stringContaining('my-proxy') },
    ]);
  });

  // The regression the always-on rule has to avoid: codex/cursor on an API key consume no
  // Anthropic-family credential (needsAnthropicAuth is false → `auth` undefined), and the proxy's
  // primary sidecar refuses to start without one. Forcing the proxy on would make these runs
  // unstartable, so they run direct, with the advisory naming the provider.
  for (const [provider, env] of [
    ['codex', { CODEX_API_KEY: 'sk-codex' }],
    ['codex', { OPENAI_API_KEY: 'sk-openai' }],
    ['cursor', { CURSOR_API_KEY: 'sk-cursor' }],
  ] as const) {
    it(`${provider} on ${Object.keys(env)[0]} starts (direct) and warns, instead of failing for want of a sidecar credential`, async () => {
      const repoPath = await plainRepo();
      const deps = productionDeps();
      const events: RunEvent[] = [];
      setEnv({ ...NO_CLAUDE, CODEX_AUTH_JSON: undefined, ...env });
      await expect(
        deps.createRun({ issueRef: 'o/r#1', repoPath, provider }, (e) => events.push(e)),
      ).resolves.toEqual({ prUrl: 'https://example/pr/1' });
      expect(startSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ egress: true, llmProxy: false }));
      // The API-key branch, not the subscription or direct-mode one: those would name the wrong reason.
      expect(events.filter((e) => e.type === 'warning')).toEqual([
        { type: 'warning', message: expect.stringContaining(`${provider} authenticates with its own API key`) },
      ]);
    });
  }

  it("a zai run is proxied on zai's own key: the primary sidecar holds it, no Claude credential needed", async () => {
    const repoPath = await plainRepo();
    const deps = productionDeps();
    const events: RunEvent[] = [];
    setEnv({ ...NO_CLAUDE, ZAI_API_KEY: 'zai-REAL-KEY' });
    await expect(
      deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'zai' }, (e) => events.push(e)),
    ).resolves.toEqual({ prUrl: 'https://example/pr/1' });
    expect(startSandboxContext).toHaveBeenCalledWith(expect.objectContaining({ llmProxy: true, provider: 'zai' }));
    expect(events.filter((e) => e.type === 'warning')).toEqual([]); // nothing exposed → nothing to warn about
    expect(JSON.stringify(runGithubIssue.mock.calls)).not.toContain('zai-REAL-KEY');
  });

  it('a failed dispatch disarms the cancel controller and surfaces the fault unchanged', async () => {
    const repoPath = await plainRepo();
    const deps = productionDeps();
    setEnv({ ...NO_CLAUDE, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' });
    // Every docker/enclave fault startSandboxContext raises is a SandboxError, which classifyCoreError
    // already reports bad-request: passed through, not re-wrapped (re-wrapping would relabel a genuine
    // internal fault as a caller mistake).
    startSandboxContext.mockRejectedValueOnce(new SandboxError('Failed to start egress enclave'));
    await expect(deps.createRun({ issueRef: 'o/r#1', repoPath }, () => {})).rejects.toBeInstanceOf(SandboxError);
    // The controller is armed by then and the run's `finally` never runs, so the catch must disarm it:
    // no stale armed controller outlives the failed run.
    expect(beginRun).toHaveBeenCalledOnce();
    expect(endRun).toHaveBeenCalledOnce();
    expect(runGithubIssue).not.toHaveBeenCalled();
  });
});

/**
 * The assertions above only prove `deps.ts` itself never writes the raw secret into the args it hands
 * `runGithubIssue` — but `runGithubIssue` is a whole-module mock there, so they say nothing about the
 * actual safety boundary: source-adapter.ts's own guard (`deps.llmProxy`), which decides whether a used
 * provider's real credential ever reaches the Docker sandbox's `secrets`. Exercising that guard means
 * running the REAL runGithubIssue → githubAdapter → runSourcedIssue chain (only its I/O — `gh`, skills —
 * swapped out), down to the single line that constructs DockerSandboxProvider, where this block captures
 * `secrets` and short-circuits before the sandbox would actually start.
 */
describe('createRun: the real credential never reaches Docker secrets (source-adapter.ts guard)', () => {
  const TASK = { id: 'o/r#1', title: 't', description: '', labels: [], children: [], comments: [] };
  const STOP = 'test boundary: stop right after the sandbox secrets are built';

  /**
   * Re-import `./deps.js` with `../runners/github.js` wired to the real `runGithubIssue` (only
   * `githubDepsFromEnv` replaced, mirroring production's shape — an `auth` carrying the real
   * credential, same as `githubDepsFromEnv` itself computes), and `../sandbox/docker.js` swapped for a
   * capture that throws right after recording `secrets`.
   */
  async function freshCreateRunCapturingDockerSecrets(
    auth: unknown,
  ): Promise<{ createRun: ReturnType<typeof productionDeps>['createRun']; capturedSecrets: Array<Record<string, string>> }> {
    vi.resetModules();
    vi.doMock('../runners/github.js', async (importActual) => {
      const actual = await importActual<typeof import('../runners/github.js')>();
      return { ...actual, githubDepsFromEnv: async (repoPath: string) => ({ auth, repoPath, repoSlug: 'o/r' }) };
    });
    vi.doMock('../tasks/github.js', () => ({
      GitHubTaskFetcher: class {
        async fetch(): Promise<typeof TASK> {
          return TASK;
        }
      },
      defaultGhRunner: vi.fn(),
      linkPullRequest: vi.fn(),
      addPrFailureLabel: vi.fn(),
      editGithubLabels: vi.fn(),
      commentGithubIssue: vi.fn(),
    }));
    vi.doMock('../context/skill-registry.js', () => ({ skillRegistryForRun: vi.fn(async () => ({})) }));
    const capturedSecrets: Array<Record<string, string>> = [];
    vi.doMock('../sandbox/docker.js', () => ({
      sandboxImage: (): string => 'vanguard-sandbox:latest',
      DockerSandboxProvider: class {
        constructor(opts: { secrets?: Record<string, string> }) {
          capturedSecrets.push(opts.secrets ?? {});
          throw new Error(STOP);
        }
      },
    }));
    const fresh = await import('./deps.js');
    return { createRun: fresh.productionDeps().createRun, capturedSecrets };
  }

  afterEach(() => {
    vi.doUnmock('../runners/github.js');
    vi.doUnmock('../tasks/github.js');
    vi.doUnmock('../context/skill-registry.js');
    vi.doUnmock('../sandbox/docker.js');
    vi.resetModules();
  });

  for (const { label, guard, env, auth, provider, secret } of [
    {
      label: 'a Claude subscription token',
      guard: 'llmProxy',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-REAL-TOKEN', ANTHROPIC_API_KEY: undefined },
      auth: { mode: 'subscription', token: 'sk-ant-oat01-REAL-TOKEN' },
      provider: 'claude',
      secret: 'sk-ant-oat01-REAL-TOKEN',
    },
    {
      label: 'a zai key',
      guard: 'proxyMode',
      env: { CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ZAI_API_KEY: 'zai-REAL-KEY' },
      auth: undefined,
      provider: 'zai',
      secret: 'zai-REAL-KEY',
    },
  ] as const) {
    it(`${label} is withheld from Docker secrets under the proxy — leaks if the ${guard} guard is removed`, async () => {
      setEnv(env);
      const { createRun, capturedSecrets } = await freshCreateRunCapturingDockerSecrets(auth);
      const repoPath = await plainRepo();
      await expect(createRun({ issueRef: 'o/r#1', repoPath, provider }, () => {})).rejects.toThrow(STOP);
      expect(capturedSecrets).toHaveLength(1);
      expect(JSON.stringify(capturedSecrets)).not.toContain(secret);
    });
  }
});

describe('production run-store forwards', () => {
  const timestamp = '2026-06-06T10:00:00.000Z';
  const result: RunResult = {
    taskId: 't', completed: true, exitReason: 'completed', turns: 1,
    worktreePath: '/wt', worktreePreserved: false, finalText: 'done', diff: '', costUsd: 0.1,
  };
  const proof = { command: 'test', exitCode: 0, passed: true, sha256: 'abc', outputTail: 'ok' };
  const repos: string[] = [];
  async function repo(): Promise<string> {
    const path = await plainRepo();
    repos.push(path);
    return path;
  }
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('groups stages once, sorts newest first, and omits absent optional fields', async () => {
    const repoPath = await repo();
    await beginStoredRun(repoPath, 't', timestamp).writeStages([
      { name: 'implement', result }, { name: 'review', result: { ...result, completed: false } },
    ]);
    const newer = '2026-06-06T11:00:00.000Z';
    await beginStoredRun(repoPath, 't', newer).writeStages([{ name: 'implement', result }]);
    const runs = await productionDeps().listRuns({ repoPath });
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.timestamp)).toEqual([newer, timestamp]);
    expect(runs[1]).toMatchObject({ taskId: 't', stages: ['implement', 'review'], totalCostUsd: 0.2, anyFailed: true });
    expect(runs[0]!.anyFailed).toBe(false);
    expect(runs[1]).not.toHaveProperty('prUrl');
  });

  it.each([
    ['2026-06-06T09:59:57.000Z', true],
    ['2026-06-06T10:00:03.000Z', false],
    ['2026-06-06T09:49:59.000Z', false],
  ] as const)('proof fallback for %s is %s through core dispatch', async (proofTs, found) => {
    const repoPath = await repo();
    await beginStoredRun(repoPath, 't', timestamp).writeStages([{ name: 'implement', result }]);
    await beginStoredRun(repoPath, 't', proofTs).writeProof(proof);
    const detail = await invokeCoreMethod(productionDeps(), 'readRun', { repoPath, taskId: 't', timestamp });
    expect(detail).toMatchObject({ taskId: 't', timestamp });
    expect((detail as { proof?: unknown }).proof !== undefined).toBe(found);
    expect((await productionDeps().readRun({ repoPath, taskId: 't', timestamp })).proof !== undefined).toBe(found);
  });

  it('skips an unreadable record and keeps the good run through core dispatch', async () => {
    const repoPath = await repo();
    await beginStoredRun(repoPath, 't', timestamp).writeStages([{ name: 'review', result }]);
    await mkdir(join(runsRoot(repoPath), 't', sanitizeTimestamp(timestamp) + '-implement.json'));
    const runs = await invokeCoreMethod(productionDeps(), 'listRuns', { repoPath });
    expect(runs).toMatchObject([{ taskId: 't', timestamp, stages: ['review'] }]);
    expect(await productionDeps().listRuns({ repoPath })).toHaveLength(1);
  });

  it('retains task-id defence and reports the missing task path', async () => {
    const repoPath = await repo();
    await expect(productionDeps().readRun({ repoPath, taskId: '../escape', timestamp })).rejects.toBeInstanceOf(BadRequestError);
    await expect(productionDeps().readRun({ repoPath, taskId: 'missing', timestamp })).rejects.toThrow(join(runsRoot(repoPath), 'missing'));
  });
});
