import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { dispatchRpc, classifyError, FLEET_DISABLED_MESSAGE, type RpcContext } from './rpc.js';
import * as clone from './clone.js';
import { loadPaths } from './projects.js';
import { ProjectAllowlist } from './allowlist.js';
import { WatchRegistry } from './watch.js';
import { createRunSession } from './run-session.js';
import { CompleteRegistry } from './complete.js';
import { writeAppConfig } from './app-config.js';
import { BadRequestError, runSidecar, type SidecarDeps } from '../sidecar/sidecar.js';
import { VanguardError } from '../core/errors.js';
import type { ChildProcess } from 'node:child_process';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  pid = 1;
  kill(): boolean {
    return true;
  }
}

function fakeDeps(overrides: Partial<SidecarDeps> = {}): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: () => ({
      providers: ['claude'],
      flows: [],
      stages: [],
      transports: ['github', 'linear'],
      defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
    }),
    createRun: unimplemented,
    createTask: async (p) => ({ id: 'created', url: 'https://example/created', ...{ _params: p } } as never),
    listFlows: async () => ({ flows: [] }),
    listProviders: async () => ({ providers: [] }),
    readFlow: unimplemented,
    writeFlow: async () => ({ source: '' }),
    deleteFlow: async () => ({}),
    listTasks: async () => ({ tasks: [], capped: false }),
    fetchSpec: async () => ({ spec: '' }),
    listRepoFiles: async () => ({ files: [], capped: false }),
    readRepoFile: async () => ({ path: '', content: '', truncated: false }),
    ...overrides,
  };
}

const cleanups: string[] = [];

async function makeCtx(
  repoPath: string,
  opts: { depsOverrides?: Partial<SidecarDeps>; bind?: { isLoopback: boolean; allowAdd: boolean }; spawnComplete?: () => ChildProcess } = {},
): Promise<{ ctx: RpcContext; published: { name: string; payload: unknown }[]; deps: SidecarDeps }> {
  const configDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-cfg-'));
  const browseRoot = await mkdtemp(join(tmpdir(), 'vanguard-hub-browse-'));
  cleanups.push(configDir, browseRoot);
  const deps = fakeDeps(opts.depsOverrides);
  const published: { name: string; payload: unknown }[] = [];
  const publish = (name: string, payload: unknown): void => {
    published.push({ name, payload });
  };
  const ctx: RpcContext = {
    allowlist: new ProjectAllowlist(async () => [], repoPath),
    watchRegistry: new WatchRegistry(),
    runSession: createRunSession(deps, publish),
    completeRegistry: new CompleteRegistry(opts.spawnComplete ?? (() => new FakeChild() as unknown as ChildProcess)),
    deps,
    configDir,
    browseRoot,
    bind: opts.bind ?? { isLoopback: true, allowAdd: false },
    publish,
  };
  return { ctx, published, deps };
}

async function tmpRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'vanguard-hub-repo-'));
  cleanups.push(repo);
  // realpath so assertions built on this path match the allowlist's realpath'd comparisons, even
  // on platforms (e.g. macOS) where the OS temp dir is itself a symlink.
  return realpath(repo);
}

afterEach(() => {
  cleanups.length = 0;
});

describe('dispatchRpc', () => {
  test('T-54 dispatches commands with their exact camelCase args to the right handler', async () => {
    const repo = await tmpRepo();
    let seenCapabilities = false;
    const { ctx } = await makeCtx(repo, {
      depsOverrides: {
        capabilities: () => {
          seenCapabilities = true;
          return { providers: [], flows: [], stages: [], transports: [], defaults: { provider: 'claude', maxTurns: 1, maxCostUsd: 1, baseBranch: 'main' } };
        },
        listFlows: async (p) => {
          expect(p.repoPath).toBe(await ctx.allowlist.assertAllowed(repo));
          return { flows: [] };
        },
      },
    });
    await dispatchRpc(ctx, 'api_capabilities', {});
    expect(seenCapabilities).toBe(true);
    await dispatchRpc(ctx, 'api_list_flows', { repoPath: repo });
    const runs = await dispatchRpc(ctx, 'list_runs', { repoPath: repo });
    expect(runs).toEqual([]);
  });

  test('T-55 unknown command classifies as a 404-flavored bad-request', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await expect(dispatchRpc(ctx, 'totally_bogus', {})).rejects.toThrow(/unknown command/);
    try {
      await dispatchRpc(ctx, 'totally_bogus', {});
      expect.unreachable();
    } catch (e) {
      const classified = classifyError(e);
      expect(classified.kind).toBe('bad-request');
      expect(classified.notFound).toBe(true);
    }
  });

  test('T-56 BadRequestError classifies bad-request, other throws classify internal', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    try {
      await dispatchRpc(ctx, 'list_runs', { repoPath: '/not/allowed' });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('bad-request');
    }

    const { ctx: ctx2 } = await makeCtx(repo, {
      depsOverrides: {
        listFlows: async () => {
          throw new Error('fault');
        },
      },
    });
    try {
      await dispatchRpc(ctx2, 'api_list_flows', { repoPath: repo });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('internal');
    }
  });

  test('T-57 void commands return null, never undefined', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await writeAppConfig(repo, {});
    const result = await dispatchRpc(ctx, 'write_app_config', { repoPath: repo, config: { label: 'x' } });
    expect(result).toBeNull();
    const cancelResult = await dispatchRpc(ctx, 'api_cancel', {});
    expect(cancelResult).toBeNull();
  });

  test('T-58 Fleet commands are refused in hub mode', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    for (const cmd of ['spawn_run', 'kill_run', 'list_spawns']) {
      await expect(dispatchRpc(ctx, cmd, {})).rejects.toThrow(FLEET_DISABLED_MESSAGE);
    }
  });

  test('T-59 a repoPath outside the allowlist is refused for every path-taking command', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    const outside = await mkdtemp(join(tmpdir(), 'vanguard-hub-outside-'));
    cleanups.push(outside);
    const cases: [string, Record<string, unknown>][] = [
      ['list_runs', { repoPath: outside }],
      ['list_active', { repoPath: outside }],
      ['read_app_config', { repoPath: outside }],
      ['list_drafts', { repoPath: outside }],
      ['list_remote_runs', { repoPath: outside }],
      ['list_tasks', { repoPath: outside }],
      ['api_list_flows', { repoPath: outside }],
      ['api_repo_ok', { repoPath: outside }],
      ['watch_project', { repoPath: outside }],
    ];
    for (const [cmd, args] of cases) {
      if (cmd === 'api_repo_ok') {
        await expect(dispatchRpc(ctx, cmd, args)).resolves.toBe(false);
        continue;
      }
      await expect(dispatchRpc(ctx, cmd, args)).rejects.toThrow(/not an allowed project/);
    }
  });

  test('T-60 api_create_task substitutes source/team/label from app.json and ignores client values', async () => {
    const repo = await tmpRepo();
    let captured: unknown;
    const { ctx } = await makeCtx(repo, {
      depsOverrides: {
        createTask: async (p) => {
          captured = p;
          return { id: 'x', url: 'https://x' };
        },
      },
    });
    await writeAppConfig(repo, { source: 'linear', team: 'DEV', label: 'vanguard-ready' });
    await dispatchRpc(ctx, 'api_create_task', {
      repoPath: repo,
      title: 'hello',
      body: 'world',
      // A client-supplied source/team/label must be ignored entirely (not even read).
      source: 'github',
      team: 'ATTACKER',
      label: 'nope',
    });
    expect(captured).toMatchObject({ source: 'linear', team: 'DEV', labels: ['vanguard-ready'], title: 'hello', body: 'world' });
  });

  test('api_create_task requires a Linear team key when source is linear and none is configured', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    await writeAppConfig(repo, { source: 'linear' });
    await expect(dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' })).rejects.toThrow(/Linear team/);
  });

  test('T-61 api_complete strips a client baseUrl, substitutes chatBaseUrl, and forces assetRoot', async () => {
    const repo = await tmpRepo();
    await writeAppConfig(repo, { chatBaseUrl: 'https://proxy.internal' });
    const fake = new FakeChild();
    let sent = '';
    fake.stdin.on('data', (c: Buffer) => {
      sent += c.toString('utf8');
    });
    const { ctx } = await makeCtx(repo, { spawnComplete: () => fake as unknown as ChildProcess });
    const promise = dispatchRpc(ctx, 'api_complete', {
      repoPath: repo,
      req: { messages: [], model: 'm', baseUrl: 'https://attacker.example', assetRoot: '/' },
    });
    await new Promise((r) => setTimeout(r, 20));
    fake.stdout.write(`${JSON.stringify({ text: 'ok' })}\n`);
    await promise;
    const payload = JSON.parse(sent.trim()) as Record<string, unknown>;
    expect(payload.baseUrl).toBe('https://proxy.internal');
    expect(payload.assetRoot).toBe(join(repo, '.vanguard', 'drafts'));
  });

  test('T-62 api_complete forwards only the CompleteParams allowlist fields', async () => {
    const repo = await tmpRepo();
    const fake = new FakeChild();
    let sent = '';
    fake.stdin.on('data', (c: Buffer) => {
      sent += c.toString('utf8');
    });
    const { ctx } = await makeCtx(repo, { spawnComplete: () => fake as unknown as ChildProcess });
    const promise = dispatchRpc(ctx, 'api_complete', {
      repoPath: repo,
      req: { messages: [{ role: 'user', content: 'hi' }], model: 'm', system: 's', attachments: ['a'], evilExtra: 'drop me' },
    });
    await new Promise((r) => setTimeout(r, 20));
    fake.stdout.write(`${JSON.stringify({ text: 'ok' })}\n`);
    await promise;
    const payload = JSON.parse(sent.trim()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('evilExtra');
    expect(payload.system).toBe('s');
    expect(payload.attachments).toEqual(['a']);
  });

  test('api_create_task rejects an invalid configured source as bad-request (#493)', async () => {
    const repo = await tmpRepo();
    const { ctx } = await makeCtx(repo);
    // app.json can hold any string (no enum at that boundary) — a stale/hand-edited value must still
    // be caught by createTask's own validator, not silently forwarded to the transport.
    await writeAppConfig(repo, { source: 'not-a-real-tracker' });
    try {
      await dispatchRpc(ctx, 'api_create_task', { repoPath: repo, title: 't', body: 'b' });
      expect.unreachable();
    } catch (e) {
      expect(classifyError(e).kind).toBe('bad-request');
    }
  });

  test('BadRequestError, VanguardError and a generic Error classify identically on the sidecar and hub paths', async () => {
    const repo = await tmpRepo();
    async function* lines(...ls: string[]): AsyncIterable<string> {
      for (const l of ls) yield l;
    }
    const cases = [new BadRequestError('bad request'), new VanguardError('vanguard failure'), new Error('generic failure')];
    for (const err of cases) {
      const out: string[] = [];
      await runSidecar(
        lines(JSON.stringify({ id: 'x', method: 'listFlows', params: { repoPath: '/abs' } })),
        (l) => out.push(l),
        fakeDeps({
          listFlows: async () => {
            throw err;
          },
        }),
      );
      const sidecarKind = (JSON.parse(out[0]!) as { error: { kind: string } }).error.kind;

      const { ctx } = await makeCtx(repo, {
        depsOverrides: {
          listFlows: async () => {
            throw err;
          },
        },
      });
      let hubKind: string | undefined;
      try {
        await dispatchRpc(ctx, 'api_list_flows', { repoPath: repo });
        expect.unreachable();
      } catch (e) {
        hubKind = classifyError(e).kind;
      }
      expect(hubKind).toBe(sidecarKind);
    }
  });
});


test('clone_project registers the clone, returns its summary and publishes progress', async () => {
  const { ctx, published } = await makeCtx(await tmpRepo());
  const target = join(ctx.browseRoot, 'repo');
  await mkdir(join(target, '.git'), { recursive: true });
  const mock = vi.spyOn(clone, 'cloneProject').mockImplementation(async (_root, _params, deps) => {
    deps?.onProgress?.('receiving objects');
    return target;
  });
  try {
    ctx.cloneHosts = ['internal.example'];
    const result = await dispatchRpc(ctx, 'clone_project', { url: 'https://internal.example/org/repo.git', parentDir: ctx.browseRoot });
    expect(result).toMatchObject({ path: target, name: 'repo' });
    expect(await loadPaths(ctx.configDir)).toEqual([target]);
    expect(published).toContainEqual({ name: 'vanguard:clone-progress', payload: { line: 'receiving objects' } });
    expect(mock).toHaveBeenCalledWith(ctx.browseRoot, expect.anything(), expect.objectContaining({ allowedHosts: ctx.cloneHosts }));
  } finally {
    mock.mockRestore();
  }
});

test('clone_project enforces mutation permissions before cloning', async () => {
  const { ctx } = await makeCtx(await tmpRepo(), { bind: { isLoopback: false, allowAdd: false } });
  const mock = vi.spyOn(clone, 'cloneProject');
  try {
    await expect(dispatchRpc(ctx, 'clone_project', { url: 'https://github.com/org/repo.git', parentDir: ctx.browseRoot }))
      .rejects.toThrow('disabled on a non-loopback bind');
    expect(mock).not.toHaveBeenCalled();
    expect(await loadPaths(ctx.configDir)).toEqual([]);
  } finally {
    mock.mockRestore();
  }
});

test('add_project is confined to the browse root, like browse_dirs', async () => {
  const outsideRepo = await tmpRepo();
  await mkdir(join(outsideRepo, '.git'));
  const { ctx } = await makeCtx(outsideRepo);
  await expect(dispatchRpc(ctx, 'add_project', { path: outsideRepo })).rejects.toThrow('path escapes the browse root');
  expect(await loadPaths(ctx.configDir)).toEqual([]);

  const inside = join(await realpath(ctx.browseRoot), 'repo');
  await mkdir(join(inside, '.git'), { recursive: true });
  // An unresolved spelling (`..`, a symlinked temp dir) is stored as its realpath.
  await dispatchRpc(ctx, 'add_project', { path: `${ctx.browseRoot}/repo/../repo` });
  expect(await loadPaths(ctx.configDir)).toEqual([inside]);
});
