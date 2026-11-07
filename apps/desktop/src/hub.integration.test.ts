// Integration test for the hub<->browser transport seam (the `{result}` envelope drift, #484):
// boots the real createHubServer (src/hub/server.ts) on a real socket, points the browser-side
// transport (./transport.ts) and ipc.ts wrappers at it, and drives them through actual HTTP/SSE
// traffic. Catches drift that src/hub/server.test.ts (raw fetch against the server's own literal
// envelope) and transport.test.ts (a stubbed fetch/FakeEventSource against transport's own copy)
// cannot: the two never cross the same seam.
//
// `environment: node` (not the project default jsdom): importing createHubServer pulls in the
// sandbox/runner graph, and under jsdom a module that both calls `new URL(x, import.meta.url)` and
// imports a node_modules package resolves to a non-file-scheme URL (a Vite SSR/jsdom interaction,
// unrelated to this code) — `fileURLToPath` then throws. Plain `node` sidesteps it; the minimal
// `window` stub below is all `transport.ts`'s hub-mode branch needs.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { execa } from 'execa';
import { createHubServer, type HubServer } from '../../../src/hub/server.js';
import { beginRun } from '../../../src/core/run-store.js';
import { listRunSummaries, defaultRunsRoot } from '../../../src/hub/runs.js';
import { savePaths } from '../../../src/hub/projects.js';
import type { SidecarDeps } from '../../../src/sidecar/sidecar.js';
import type { RunResult } from '../../../src/core/types.js';
import type { VerificationResult } from '../../../src/pipeline/verify.js';
import { listProjects, listRuns, readRun, apiRepoOk } from './ipc';
import { subscribe } from './transport';

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

/** Just the `location`/`history`/`sessionStorage` surface `transport.ts`'s token handoff touches. */
function stubBrowserUrl(href: string): void {
  const store = new Map<string, string>();
  const location = new URL(href);
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', {
    state: null,
    replaceState: (_state: unknown, _title: string, url: string): void => {
      location.href = new URL(url, location.href).href;
    },
  });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => void store.set(k, v),
    clear: (): void => store.clear(),
  });
}

function unimplementedDeps(): SidecarDeps {
  const unimplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    capabilities: () => ({
      providers: ['claude'],
      flows: [],
      stages: [],
      transports: ['github'],
      defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' },
    }),
    createRun: unimplemented,
    createTask: unimplemented,
    listFlows: async () => ({ flows: [] }),
    listProviders: async () => ({ providers: [] }),
    readFlow: unimplemented,
    writeFlow: unimplemented,
    deleteFlow: unimplemented,
    listTasks: async () => ({ tasks: [], capped: false }),
    fetchSpec: unimplemented,
    listRepoFiles: async () => ({ files: [], capped: false }),
    readRepoFile: unimplemented,
    listRuns: unimplemented,
    readRun: unimplemented,
  };
}

/** Minimal `EventSource` — jsdom doesn't implement one and we're not using jsdom here anyway.
 * Opens a real HTTP connection to the hub's `/events` SSE endpoint and dispatches frames by name,
 * exactly like a browser's EventSource, so `transport.ts`'s `subscribe()` is exercised unmodified. */
class MinimalEventSource {
  private readonly listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  private closed = false;
  private readonly controller = new AbortController();

  constructor(url: string) {
    void this.connect(url);
  }

  addEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
  }

  removeEventListener(name: string, cb: (ev: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
  }

  private async connect(url: string): Promise<void> {
    try {
      const res = await fetch(url, { signal: this.controller.signal });
      const reader = res.body?.getReader();
      if (reader === undefined) return;
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this.dispatch(frame);
        }
      }
    } catch {
      // closed/aborted mid-stream — nothing left to clean up
    }
  }

  private dispatch(frame: string): void {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
    }
    if (event === undefined) return; // keepalive comment or an id-only line
    const handlers = this.listeners.get(event);
    if (handlers === undefined || handlers.size === 0) return;
    const messageEvent = { data: dataLines.join('\n') } as MessageEvent;
    for (const handler of handlers) handler(messageEvent);
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TASK_ID = 'task-1';
const TIMESTAMP = '2026-10-18T12:00:00.000Z';
const realFetch = globalThis.fetch;

let repo: string;
let configDir: string;
let browseRoot: string;
let uiDir: string;
let hub: HubServer;
let baseUrl: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vanguard-hub-integration-repo-'));
  configDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-integration-cfg-'));
  browseRoot = await mkdtemp(join(tmpdir(), 'vanguard-hub-integration-browse-'));
  uiDir = await mkdtemp(join(tmpdir(), 'vanguard-hub-integration-ui-'));
  await writeFile(join(uiDir, 'index.html'), '<html><head></head><body>hi</body></html>');

  await execa('git', ['init', '-b', 'main'], { cwd: repo });
  await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: repo });

  // Seed one run through the real persistence path (core/run-store.ts), not a hand-rolled fixture
  // JSON file, so a change to the record shape would break this test the same way it would a real run.
  const result: RunResult = {
    taskId: TASK_ID,
    completed: true,
    exitReason: 'completed',
    turns: 3,
    worktreePath: join(repo, '.worktree'),
    worktreePreserved: false,
    finalText: 'ok',
    costUsd: 0.25,
  };
  const writer = beginRun(repo, TASK_ID, TIMESTAMP);
  await writer.writeStages([{ name: 'implement', result }]);
  const verification: VerificationResult = {
    command: 'pnpm test',
    exitCode: 0,
    passed: true,
    sha256: 'deadbeef',
    outputTail: 'all green',
  };
  await writer.writeProof(verification);

  // `seedRepoPath` below only widens the RPC allowlist; `list_projects` reads the persisted project
  // store (src/hub/projects.ts), so the seeded repo must be written there too to show up in it.
  await savePaths(configDir, [repo]);

  hub = createHubServer({
    uiDir,
    configDir,
    browseRoot,
    bind: { isLoopback: true, allowAdd: false },
    seedRepoPath: repo,
    deps: unimplementedDeps(),
  });
  await hub.listen(0, '127.0.0.1');
  const { port } = hub.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  window.__VANGUARD_HUB__ = true;
  // What the browser does with the CLI's launch URL (`/#token=…`): the served page carries no token.
  stubBrowserUrl(`${baseUrl}/#token=${hub.token}`);
  // A same-origin browser page: Origin on every non-GET request, and a one-entry cookie jar for the
  // `/events` session cookie (Node's fetch keeps none).
  let cookie: string | undefined;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if ((init?.method ?? 'GET') !== 'GET') headers.set('origin', baseUrl);
    if (cookie !== undefined) headers.set('cookie', cookie);
    const res = await realFetch(`${baseUrl}${String(input)}`, { ...init, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie !== null) cookie = setCookie.split(';', 1)[0];
    return res;
  });
  vi.stubGlobal('EventSource', MinimalEventSource);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete window.__VANGUARD_HUB__;
  await hub.close();
  await rm(repo, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(browseRoot, { recursive: true, force: true });
  await rm(uiDir, { recursive: true, force: true });
});

describe('hub <-> browser transport integration', () => {
  test('listProjects() resolves an array containing the seeded repo', async () => {
    const projects = await listProjects();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.some((p) => p.path === repo)).toBe(true);
  });

  test('listRuns() deep-equals listRunSummaries(); readRun() has proof defined', async () => {
    const runs = await listRuns(repo);
    const direct = await listRunSummaries(defaultRunsRoot(repo));
    expect(runs).toEqual(direct);
    expect(runs).toHaveLength(1);

    const detail = await readRun(repo, { source: { kind: 'local' }, taskId: TASK_ID, timestamp: TIMESTAMP });
    expect(detail.proof).toBeDefined();
    expect(detail.proof?.passed).toBe(true);
  });

  test('apiRepoOk() resolves false (not null) for a disallowed path', async () => {
    await expect(apiRepoOk('/x')).resolves.toBe(false);
  });

  test('listRuns() on a disallowed path rejects with the server message string', async () => {
    await expect(listRuns('/not/allowed')).rejects.toThrow('repoPath does not exist: /not/allowed');
  });

  test('a published vanguard:changed reaches subscribe() through the EventSource polyfill', async () => {
    const received: unknown[] = [];
    const unlisten = await subscribe<{ path: string }>('vanguard:changed', (e) => received.push(e.payload));
    await waitUntil(() => hub.eventBus.clientCount >= 1);

    hub.eventBus.publish('vanguard:changed', { path: repo });
    await waitUntil(() => received.length >= 1);

    expect(received).toEqual([{ path: repo }]);
    unlisten();
  });
});
