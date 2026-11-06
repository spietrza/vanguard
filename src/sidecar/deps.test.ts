import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
