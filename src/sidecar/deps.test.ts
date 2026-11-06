import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const runGithubIssue = vi.fn(async () => ({ prUrl: 'https://example/pr/1' }));
vi.mock('../runners/github.js', () => ({
  githubDepsFromEnv: (...args: unknown[]): Promise<unknown> => githubDepsFromEnv(...(args as [])),
  runGithubIssue: (...args: unknown[]): Promise<unknown> => runGithubIssue(...(args as [])),
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

describe('createRun provider fail-fast (S6)', () => {
  beforeEach(() => {
    beginRun.mockClear();
    startSandboxContext.mockClear();
    githubDepsFromEnv.mockClear();
    runGithubIssue.mockClear();
  });

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
    process.env.MY_PROXY_API_KEY = 'sk-test';
    try {
      const result = await deps.createRun({ issueRef: 'o/r#1', repoPath, provider: 'my-proxy' }, () => {});
      expect(result).toEqual({ prUrl: 'https://example/pr/1' });
    } finally {
      delete process.env.MY_PROXY_API_KEY;
    }
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
